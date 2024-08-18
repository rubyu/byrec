import {AggregatedValue, Aggregatable, StoredEvent} from "./types";
import { EventStore, GetEventsOptions } from "./eventStore";

interface ProcessedRange {
    start: number;
    end: number;
}

const MetadataStoreName = 'Metadata';
const ProcessedRangesKey = 'ProcessedRanges';

export type AggregatorChangeListener<V> = (changedItem: V) => void;

export abstract class EventAggregator<V extends Aggregatable, A extends AggregatedValue<string>> {
    protected db: IDBDatabase | null = null;
    private processedRanges: ProcessedRange[] = [];
    private processingIntervalId: number | null = null;
    private listeners: Set<AggregatorChangeListener<A>> = new Set();

    constructor(
        protected eventStore: EventStore<V>,
        protected databaseName: string,
        protected databaseVersion: number = 1,
        protected batchSize: number = 100,
        protected processingInterval: number = 1000,
    ) {}

    private _initializationTried = false;
    private _initializationError: any = null;
    private _initializationSucceeded = false;

    isInitialized() {
        return this._initializationTried;
    }

    isInitializationSucceeded() {
        return this._initializationSucceeded;
    }

    getInitializationError() {
        return this._initializationError;
    }

    async initialize(): Promise<void> {
        if (!this._initializationTried) {
            try {
                await this.initializeDatabase();
                await this.loadProcessedRanges();
                this.eventStore.subscribe(this.handleNewEvent.bind(this));
                this._initializationSucceeded = true;
            } catch (err) {
                this._initializationError = err;
            } finally {
                this._initializationTried = true;
            }
        }
    }

    protected abstract applyMigrations(db: IDBDatabase, oldVersion: number, newVersion: number): void;
    protected abstract processEvent(trx: IDBTransaction, event: StoredEvent<V>): Promise<A | null>;
    abstract getAggregated(itemIds: string[]): Promise<{ [key: string]: A }>

    private async initializeDatabase(): Promise<void> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.databaseName, this.databaseVersion);
            request.onerror = () => reject(new Error(`Failed to open database: ${request.error?.message}`));
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };
            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                const oldVersion = event.oldVersion;
                const newVersion = event.newVersion || db.version;
                try {
                    this.applyMetadataMigrations(db, oldVersion, newVersion);
                    this.applyMigrations(db, oldVersion, newVersion);
                } catch (error) {
                    console.error('Error during database migration:', error);
                    reject(error);
                }
            };
        });
    }

    private applyMetadataMigrations(db: IDBDatabase, oldVersion: number, newVersion: number): void {
        if (oldVersion < 1) {
            const store = db.createObjectStore(MetadataStoreName, {keyPath: 'key'});
        }
    }

    private async loadProcessedRanges(): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');

        return new Promise((resolve, reject) => {
            const trx = this.db!.transaction([MetadataStoreName], 'readonly');
            const store = trx.objectStore(MetadataStoreName);
            const request = store.get(ProcessedRangesKey);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.processedRanges = request.result?.value ?? [];
                resolve();
            };
        });
    }

    private async saveProcessedRanges(tx: IDBTransaction): Promise<void> {
        return new Promise((resolve, reject) => {
            const store = tx.objectStore(MetadataStoreName);
            const request = store.put({ key: ProcessedRangesKey, value: this.processedRanges });
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    startProcessing(): void {
        if (this.processingIntervalId === null) {
            const self = this;
            this.processingIntervalId = Number(setInterval(async () => {
                await self.processEvents();
            }, this.processingInterval));
        }
    }

    stopProcessing(): void {
        if (this.processingIntervalId !== null) {
            clearInterval(this.processingIntervalId);
            this.processingIntervalId = null;
        }
    }

    private notifyListeners(changes: A[]): void {
        changes.forEach(updated => {
            this.listeners.forEach(listener => {
                try {
                    listener(updated);
                } catch (error) {
                    console.error('Error in listener:', error);
                }
            });
        });
    }

    subscribe(listener: AggregatorChangeListener<A>): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private async handleNewEvent(ev: StoredEvent<V>): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');

        const tx = this.db.transaction(this.db.objectStoreNames, 'readwrite');
        try {
            const changedItem = await this.processEvent(tx, ev);
            this.updateProcessedRanges(ev.localId, ev.localId);
            await this.saveProcessedRanges(tx);
            if (changedItem) {
                this.notifyListeners([changedItem]);
            }
            return new Promise<void>((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (err) {
            console.error("Error processing new event:", err);
            tx.abort();
        }
    }

    private async processEvents(): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');

        if (this.isFullyCovered()) {
            this.stopProcessing();
            return;
        }

        const range = await this.findRangeToProcess();
        if (!range) {
            return;
        }

        const options: GetEventsOptions = { limit: Math.min(this.batchSize, range.end - range.start - 1) };
        const eventsBefore = await this.eventStore.getEventsBefore(range.end, options);
        if (eventsBefore.length === 0) {
            return;
        }
        const maxId = eventsBefore[0].localId;
        const minId = eventsBefore[eventsBefore.length-1].localId;

        const changedItems: A[] = [];
        const tx = this.db.transaction(this.db.objectStoreNames, 'readwrite');
        try {
            for (const ev of eventsBefore) {
                const changedItem = await this.processEvent(tx, ev);
                if (changedItem) {
                    changedItems.push(changedItem);
                }
            }
            if (eventsBefore.length < this.batchSize) {
                this.updateProcessedRanges(1, maxId);
            } else {
                this.updateProcessedRanges(minId, maxId);
            }
            await this.saveProcessedRanges(tx);
            return new Promise<void>((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (err) {
            console.error("Error processing events:", err);
            tx.abort();
        }
        this.notifyListeners(changedItems);
    }

    private async findRangeToProcess(): Promise<ProcessedRange | null> {
        const size = this.processedRanges.length;
        if (size === 0) {
            return { start: 0, end: Number.MAX_SAFE_INTEGER }
        }
        const rangeEnd = this.processedRanges[size-1].start;
        if (rangeEnd === 1) {
            return null;
        }
        if (rangeEnd === 0) {
            throw new Error('Unexpected value');
        }
        if (1 < size) {
            const rangeStart = this.processedRanges[size-2].end;
            return { start: rangeStart, end: rangeEnd };
        }
        // size === 1
        return { start: 0, end: rangeEnd };
    }

    private isFullyCovered(): boolean {
        if (this.processedRanges.length === 0) {
            this.eventStore.hasAnyRecord().then((hasAnyRecord) => {
                return !hasAnyRecord;
            });
            return false;
        }
        return this.processedRanges.length === 1 && this.processedRanges[0].start === 0;
    }

    private updateProcessedRanges(start: number, end: number): void {
        const newRange: ProcessedRange = { start, end };

        const allRanges = [...this.processedRanges, newRange];
        allRanges.sort((a, b) => a.start - b.start);

        const mergedRanges: ProcessedRange[] = [];
        let currentRange = allRanges[0];

        for (let i = 1; i < allRanges.length; i++) {
            const nextRange = allRanges[i];
            if (currentRange.end + 1 >= nextRange.start) {
                currentRange.end = Math.max(currentRange.end, nextRange.end);
            } else {
                mergedRanges.push(currentRange);
                currentRange = nextRange;
            }
        }
        mergedRanges.push(currentRange);

        this.processedRanges = mergedRanges;
    }

    dispose() {
        this.listeners.clear();
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}
