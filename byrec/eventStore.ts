import { Aggregatable, StoredEvent } from "./types";
import { v7 as uuidv7 } from 'uuid';

export interface GetEventsOptions {
    limit?: number;
}

const DatabaseVersion = 1;
const DataStoreName = 'Events';

export class EventStore<V extends Aggregatable> {
    private db: IDBDatabase | null = null;
    private listeners: Set<(msg: StoredEvent<V>) => Promise<void>> = new Set();

    constructor(public databaseName: string) {}

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
            } catch (err) {
                this._initializationError = err;
            } finally {
                this._initializationTried = true;
            }
        }
    }

    private async initializeDatabase(): Promise<void> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.databaseName, DatabaseVersion);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };
            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                const store = db.createObjectStore(DataStoreName, { keyPath: 'localId', autoIncrement: true });
                store.createIndex('globalId', 'globalId', { unique: true });
            };
        });
    }

    async add(value: V): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        return new Promise((resolve, reject) => {
            const trx = this.db!.transaction([DataStoreName], 'readwrite');
            const store = trx.objectStore(DataStoreName);

            const globalId = uuidv7();
            const request = store.add({ globalId, value });

            request.onerror = () => reject(new Error(`Add error: ${request.error?.message || 'Unknown error'}`));
            request.onsuccess = () => {
                const localId = request.result as number;
                const storedEvent: StoredEvent<V> = { localId, globalId, value };
                this.broadcastAddEvent(storedEvent);
                resolve();
            };
            trx.onerror = () => reject(new Error(`Transaction error: ${trx.error?.message || 'Unknown error'}`));
            trx.onabort = () => reject(new Error('Transaction aborted'));
        });
    }

    private broadcastAddEvent(event: StoredEvent<V>) {
        this.notifyListeners(event);
    }

    async getEventsAfter(localId: number, options?: GetEventsOptions): Promise<StoredEvent<V>[]> {
        return this.getEvents( 'next', IDBKeyRange.lowerBound(localId, true), options);
    }

    async getEventsBefore(localId: number, options?: GetEventsOptions): Promise<StoredEvent<V>[]> {
        return this.getEvents( 'prev', IDBKeyRange.upperBound(localId, true), options);
    }

    async hasAnyRecord(): Promise<boolean> {
        if (!this.db) throw new Error('Database not initialized');
        return new Promise((resolve, reject) => {
            const tx = this.db!.transaction([DataStoreName], 'readonly');
            const store = tx.objectStore(DataStoreName);
            const rq = store.openCursor();

            rq.onerror = () => reject(new Error('Failed to check for records'));
            rq.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest).result;
                resolve(cursor !== null);
            };
        });
    }

    private async getEvents(
        direction: IDBCursorDirection,
        range: IDBKeyRange,
        options?: GetEventsOptions
    ): Promise<StoredEvent<V>[]> {
        if (!this.db) throw new Error('Database not initialized');

        return new Promise((resolve, reject) => {
            const trx = this.db!.transaction([DataStoreName], 'readonly');
            const store = trx.objectStore(DataStoreName);

            const results: StoredEvent<V>[] = [];
            const request = store.openCursor(range, direction);
            request.onerror = () => reject(request.error);
            request.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
                if (cursor) {
                    const storedEvent: StoredEvent<V> = {
                        localId: cursor.key as number,
                        globalId: cursor.value.globalId,
                        value: cursor.value.value
                    };
                    results.push(storedEvent);
                    if (!options?.limit || results.length < options.limit) {
                        cursor.continue();
                    } else {
                        resolve(results);
                    }
                } else {
                    resolve(results);
                }
            };
        });
    }

    private notifyListeners(msg: StoredEvent<V>) {
        this.listeners.forEach(listener => {
            try {
                listener(msg);
            } catch (error) {
                console.error('Error in listener:', error);
            }
        });
    }

    subscribe(listener: (msg: StoredEvent<V>) => Promise<void>): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    async cleanupOldData(keepLatest: number = 1000): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');

        return new Promise((resolve, reject) => {
            const trx = this.db!.transaction([DataStoreName], 'readwrite');
            const store = trx.objectStore(DataStoreName);

            const countRequest = store.count();
            countRequest.onerror = () => reject(countRequest.error);
            countRequest.onsuccess = () => {
                const count = countRequest.result;
                if (count <= keepLatest) {
                    resolve();
                    return;
                }

                const deleteCount = count - keepLatest;
                let deletedCount = 0;

                const cursorRequest = store.openCursor();
                cursorRequest.onerror = () => reject(cursorRequest.error);
                cursorRequest.onsuccess = (event) => {
                    const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
                    if (cursor && deletedCount < deleteCount) {
                        const deleteRequest = cursor.delete();
                        deleteRequest.onerror = () => reject(deleteRequest.error);
                        deleteRequest.onsuccess = () => {
                            deletedCount++;
                            cursor.continue();
                        };
                    } else {
                        resolve();
                    }
                };
            };
        });
    }

    dispose() {
        this.listeners.clear();
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}
