export interface Aggregatable {}

export interface StoredEvent<V extends Aggregatable> {
    localId: number; // Auto-increment primary key
    globalId: string; // UUIDv7 for global primary key
    value: V;
}

export interface AggregatedValue<T> {
    aggregationKey: T;
}
