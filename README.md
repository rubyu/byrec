# Byrec - Event Sourcing and Aggregation Library (PoC)

Byrec is a Proof of Concept (PoC) TypeScript library for implementing event sourcing and aggregation patterns in web applications. It provides a framework for storing, processing, and aggregating events, making it easier to build scalable and maintainable applications.

## Features

- Event storage using IndexedDB
- Event aggregation with customizable processing logic
- Real-time updates through a subscription model
- React hooks for easy integration with React applications
- Showcases for common use cases (likes and listen counts)

## File Structure

```
./byrec/
├── eventAggregator.ts
├── eventStore.ts
├── types.ts
├── useEvent.tsx
├── showcases
│   ├── like
│   │   ├── likeEvent.ts
│   │   └── useLike.tsx
│   └── listen
│       ├── listenEvent.ts
│       └── useListenTotal.tsx
└── ...
```

## Core Components

### EventStore

`eventStore.ts` implements the `EventStore` class, which is responsible for storing and retrieving events using IndexedDB. It provides methods for adding events, querying events, and subscribing to new events.

#### EventStore Interface Summary

```typescript
class EventStore<V extends Aggregatable> {
  constructor(public databaseName: string);
  
  initialize(): Promise<void>;
  add(value: V): Promise<void>;

  subscribe(listener: (msg: StoredEvent<V>) => Promise<void>): () => void;
  dispose(): void;
}
```

### EventAggregator

`eventAggregator.ts` defines the abstract `EventAggregator` class. This class processes events from the `EventStore` and maintains aggregated state. It can be extended to implement custom aggregation logic for specific use cases.

#### EventAggregator Interface Summary

```typescript
abstract class EventAggregator<V extends Aggregatable, A extends AggregatedValue<string>> {
  constructor(
    protected eventStore: EventStore<V>,
    protected databaseName: string,
  );

  initialize(): Promise<void>;
  protected abstract applyMigrations(db: IDBDatabase, oldVersion: number, newVersion: number): void;
  protected abstract processEvent(trx: IDBTransaction, event: StoredEvent<V>): Promise<A | null>;
  abstract getAggregated(itemIds: string[]): Promise<{ [key: string]: A }>;

  subscribe(listener: AggregatorChangeListener<A>): () => void;
  dispose(): void;
}
```

### useEvent

`useEvent.tsx` provides a React hook and context provider for easy integration of event sourcing and aggregation in React applications.

#### useEvent Interface Summary

```typescript
function createGenericEventProvider<E extends Aggregatable, A extends AggregatedValue<string>>() {
  return {
    EventProvider: React.FC<{
      keys: string[];
      children: React.ReactNode;
      EventStore: new (databaseName: string) => EventStore<E>;
      EventAggregator: new (eventStore: EventStore<E>, databaseName: string) => EventAggregator<E, A>;
      eventStoreDatabaseName: string;
      eventAggregatorDatabaseName: string;
    }>;
    
    useEvent: () => {
      addEvent: (event: E) => Promise<void>;
      aggregatedValues: { [key: string]: A };
      isInitializing: boolean;
      isSyncing: boolean;
      error: Error | null;
    };
  };
}
```

## Detailed Example: Listen Count

Let's dive into the `listenEvent.ts` and `useListenTotal.tsx` files to demonstrate how to use `EventStore`, `EventAggregator`, and `useEvent`.

### listenEvent.ts

This file defines the structure of a listen event and implements the aggregation logic.

```typescript
// Define the structure of a listen event
export interface MusicListenEvent extends Aggregatable {
    itemId: string;
}

// Define the structure of the aggregated value
export interface MusicListenAggregationValue extends AggregatedValue<string> {
    total: number;
}

// Extend EventStore for MusicListenEvent
export class MusicListenEventStore extends EventStore<MusicListenEvent> {}

// Implement custom EventAggregator for MusicListenEvent
export class MusicListenEventAggregator extends EventAggregator<MusicListenEvent, MusicListenAggregationValue> {
    protected applyMigrations(db: IDBDatabase, oldVersion: number, newVersion: number): void {
        if (oldVersion < 1) {
            db.createObjectStore('Total', { keyPath: 'aggregationKey' });
        }
    }

    protected async processEvent(trx: IDBTransaction, event: StoredEvent<MusicListenEvent>): Promise<MusicListenAggregationValue> {
        return new Promise((resolve, reject) => {
            const store = trx.objectStore('Total');
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
        // Implementation details...
    }
}
```

This file showcases how to:
1. Define event and aggregation value interfaces
2. Extend `EventStore` for a specific event type
3. Implement a custom `EventAggregator` with migration and event processing logic

### useListenTotal.tsx

This file demonstrates how to use the `createGenericEventProvider` to create a React context and hook for the listen events.

```typescript
const { EventProvider: ListenEventProvider, useEvent: useListenEvent } = createGenericEventProvider<MusicListenEvent, MusicListenAggregationValue>();

export const ListenEventContextProvider: React.FC<{ keys: string[], children: React.ReactNode }> = ({ keys, children }) => (
    <ListenEventProvider
        keys={keys}
        EventStore={MusicListenEventStore}
        EventAggregator={MusicListenEventAggregator}
        eventStoreDatabaseName="MusicListenEvents_V2"
        eventAggregatorDatabaseName="MusicListenAggregator_V3"
    >
        {children}
    </ListenEventProvider>
);

export { useListenEvent };
```

This file shows how to:
1. Use `createGenericEventProvider` to create a context provider and hook
2. Set up the `ListenEventContextProvider` with the custom `EventStore` and `EventAggregator`

## Usage

To use Byrec in your project, follow these steps:

1. Define your event structure and aggregation logic by extending the `EventAggregator` class (as shown in `listenEvent.ts`).
2. Create a context provider and hook using `createGenericEventProvider` (as shown in `useListenTotal.tsx`).
3. Wrap your React components with the event provider and use the hook to interact with the event system.

Example usage in a React component:

```tsx
function App() {
  return (
    <ListenEventContextProvider keys={['song1', 'song2']}>
      <MusicPlayer />
    </ListenEventContextProvider>
  );
}

function MusicPlayer() {
  const { addEvent, aggregatedValues } = useListenEvent();

  const handlePlay = (songId) => {
    addEvent({ itemId: songId });
  };

  return (
    <div>
      <button onClick={() => handlePlay('song1')}>Play Song 1</button>
      <button onClick={() => handlePlay('song2')}>Play Song 2</button>
      <p>Song 1 plays: {aggregatedValues['song1']?.total || 0}</p>
      <p>Song 2 plays: {aggregatedValues['song2']?.total || 0}</p>
    </div>
  );
}
```

This example demonstrates how to:
1. Set up the context provider with specific keys
2. Use the `useListenEvent` hook to access the `addEvent` function and `aggregatedValues`
3. Trigger events and display aggregated values in the UI

## License

This project is licensed under the MIT License.

## Contributing

As this is a Proof of Concept implementation, contributions are welcome. Please open an issue to discuss proposed changes or improvements before submitting a pull request.

## Disclaimer

This library is a Proof of Concept and may not be suitable for production use without further development and testing. Use at your own risk.
