import { Aggregatable, StoredEvent, AggregatedValue } from "../../types";
import { EventStore } from "../../eventStore";
import { EventAggregator } from "../../eventAggregator";

const LikeStatusStoreName = 'Like';

export interface LikeEvent extends Aggregatable {
    itemId: string;
    isLiked: boolean;
}

export interface LikeAggregationValue extends AggregatedValue<string> {
    isLiked: boolean;
    lastUpdated: Date;
}

export class LikeEventStore extends EventStore<LikeEvent> {}

export class LikeEventAggregator extends EventAggregator<LikeEvent, LikeAggregationValue> {
    constructor(
        protected eventStore: EventStore<LikeEvent>,
        protected databaseName: string,
        protected databaseVersion: number = 1,
        protected batchSize: number = 100,
        protected processingInterval: number = 1000,
    ) {
        super(
            eventStore,
            databaseName,
            databaseVersion,
            batchSize,
            processingInterval
        );
    }

    protected applyMigrations(db: IDBDatabase, oldVersion: number, newVersion: number): void {
        if (oldVersion < 1) {
            db.createObjectStore(LikeStatusStoreName, {keyPath: 'aggregationKey'});
        }
    }

    private extractTimestampFromUUIDv7(uuid: string): Date {
        const parts = uuid.split("-");
        const highBitsHex = parts[0] + parts[1].slice(0, 4);
        const timestampInMilliseconds = parseInt(highBitsHex, 16);
        return new Date(timestampInMilliseconds);
    }

    protected async processEvent(trx: IDBTransaction, event: StoredEvent<LikeEvent>): Promise<LikeAggregationValue | null> {
        return new Promise((resolve, reject) => {
            const store = trx.objectStore(LikeStatusStoreName);
            const aggregationKey = event.value.itemId;

            const getReq = store.get(aggregationKey);
            getReq.onerror = () => reject(getReq.error);
            getReq.onsuccess = () => {
                const currentValue = getReq.result as LikeAggregationValue | undefined;
                const eventUpdated = this.extractTimestampFromUUIDv7(event.globalId);
                if (!currentValue || eventUpdated > currentValue.lastUpdated) {
                    const latest: LikeAggregationValue = {
                        aggregationKey,
                        isLiked: event.value.isLiked,
                        lastUpdated: eventUpdated,
                    };
                    const putReq = store.put(latest);
                    putReq.onerror = () => reject(putReq.error);
                    putReq.onsuccess = () => resolve(latest);
                } else {
                    // If the event is older, don't update and return null
                    resolve(null);
                }
            };
        });
    }

    async getAggregated(itemIds: string[]): Promise<{ [key: string]: LikeAggregationValue }> {
        if (!this.db) throw new Error('Database not initialized');

        return new Promise((resolve, reject) => {
            const trx = this.db!.transaction([LikeStatusStoreName], 'readonly');
            const store = trx.objectStore(LikeStatusStoreName);

            const getItemStatus = (itemId: string): Promise<[string, LikeAggregationValue]> =>
                new Promise((resolveItem, rejectItem) => {
                    const request = store.get(itemId);
                    request.onerror = () => rejectItem(new Error(`Error fetching data for item ${itemId}: ${request.error}`));
                    request.onsuccess = () => {
                        const entry = request.result || { aggregationKey: itemId, isLiked: false, lastUpdated: new Date(0) };
                        resolveItem([itemId, entry]);
                    };
                });

            Promise.all(itemIds.map(getItemStatus))
                .then(entries =>
                    entries.reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {})
                )
                .then(resolve)
                .catch(reject);

            trx.onerror = () => {
                reject(new Error(`Transaction error: ${trx.error}`));
            };
        });
    }
}
