import {Aggregatable, AggregatedValue, StoredEvent} from "../../types";
import {EventStore} from "../../eventStore";
import {EventAggregator} from "../../eventAggregator";

const TotalStoreName = 'Total';

export interface MusicListenEvent extends Aggregatable {
    itemId: string;
}

export interface MusicListenAggregationValue extends AggregatedValue<string> {
    total: number;
}

export class MusicListenEventStore extends EventStore<MusicListenEvent> {}

export class MusicListenEventAggregator extends EventAggregator<MusicListenEvent, MusicListenAggregationValue> {

    constructor(
        protected eventStore: EventStore<MusicListenEvent>,
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
            db.createObjectStore(TotalStoreName, {keyPath: 'aggregationKey'});
        }
    }

    protected async processEvent(trx: IDBTransaction, event: StoredEvent<MusicListenEvent>): Promise<MusicListenAggregationValue> {
        return new Promise((resolve, reject) => {
            const store = trx.objectStore(TotalStoreName);
            const aggregationKey = event.value.itemId;

            const getReq = store.get(aggregationKey);
            getReq.onerror = (error) => reject(getReq.error);
            getReq.onsuccess = () => {
                const data = getReq.result as MusicListenAggregationValue | undefined;
                const total = (data?.total ?? 0) + 1;
                const updated: MusicListenAggregationValue = { aggregationKey, total };
                const putReq = store.put(updated);
                putReq.onerror = () => reject(putReq.error);
                putReq.onsuccess = () => resolve(updated);
            };
        });
    }

    async getAggregated(itemIds: string[]): Promise<{ [key: string]: MusicListenAggregationValue }> {
        if (!this.db) throw new Error('Database not initialized');

        return new Promise((resolve, reject) => {
            const trx = this.db!.transaction([TotalStoreName], 'readonly');
            const store = trx.objectStore(TotalStoreName);

            const getItemData = (itemId: string): Promise<[string, MusicListenAggregationValue]> =>
                new Promise((resolveItem, rejectItem) => {
                    const request = store.get(itemId);
                    request.onerror = () => rejectItem(new Error(`Error fetching data for item ${itemId}: ${request.error}`));
                    request.onsuccess = () => {
                        const entry = request.result ?? { aggregationKey: itemId, total: 0 };
                        resolveItem([itemId, entry]);
                    };
                });

            Promise.all(itemIds.map(getItemData))
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
