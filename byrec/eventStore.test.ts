import {Aggregatable, StoredEvent} from "@/lib/byrec/types";
import {EventStore} from './eventStore';
import { openDB } from 'idb';

function extractTimestampFromUUIDv7(uuid: string): Date {
    const parts = uuid.split("-");
    const highBitsHex = parts[0] + parts[1].slice(0, 4);
    const timestampInMilliseconds = parseInt(highBitsHex, 16);
    return new Date(timestampInMilliseconds);
}

function toBeUUIDv7(received: unknown): jest.CustomMatcherResult {
    if (typeof received !== "string") throw new Error("actual value must be a string");
    const currentDt = new Date();
    const actualDt = extractTimestampFromUUIDv7(received);
    const pass = currentDt.getTime() - actualDt.getTime() < 1000;
    const message = () => {
        return pass
            ? `OK`
            : `Invalid UUIDv7 format or the difference between the value and the current time is greater than 1sec. (${received})`;
    };
    return {
        pass,
        message,
    };
}
expect.extend({ toBeUUIDv7 });

interface MockMergeableEvent extends Aggregatable {
    data: string;
}

describe('EventRecorder without mocks', () => {
    let eventStore: EventStore<MockMergeableEvent>;

    beforeAll(() => {
    });

    beforeEach(async () => {
        const { EventStore } = await import('./eventStore');
        eventStore = new EventStore('testEventStore');
        await eventStore.initialize();
    });

    afterEach(async () => {
        eventStore.dispose();
        indexedDB.deleteDatabase('testEventStore');
    });

    test('put should add a new event', async () => {
        const event = { aggregationKey: 'test', data: 'testData' };
        await eventStore.add(event);

        const db = await openDB(eventStore.databaseName, 1);
        const keys = await db.getAllKeys('Events');
        expect(keys).toHaveLength(1);
        const key = keys[0];
        expect(key).toEqual(1);
        const storedEvent: StoredEvent<MockMergeableEvent> = await db.get('Events', key);
        expect(storedEvent).toEqual({
            localId: 1,
            globalId: expect.toBeUUIDv7(),
            value: event,
        });
        db.close();
    });

    test('getEventsAfter should return a new event', async () => {
        const event = { aggregationKey: 'test', data: 'testData' };
        await eventStore.add(event);
        const results = await eventStore.getEventsAfter(0);
        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({
            localId: 1,
            globalId: expect.toBeUUIDv7(),
            value: event,
        });
    });

    test('getEventsAfter should not return a new event', async () => {
        const event = { aggregationKey: 'test', data: 'testData' };
        await eventStore.add(event);
        const results = await eventStore.getEventsAfter(1);
        expect(results).toHaveLength(0);
    });

    test('getEventsBefore should return a new event', async () => {
        const event = { aggregationKey: 'test', data: 'testData' };
        await eventStore.add(event);
        const results = await eventStore.getEventsBefore(2);
        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({
            localId: 1,
            globalId: expect.toBeUUIDv7(),
            value: event,
        });
    });

    test('getEventsBefore should not return a new event', async () => {
        const event = { aggregationKey: 'test', data: 'testData' };
        await eventStore.add(event);
        const results = await eventStore.getEventsBefore(1);
        expect(results).toHaveLength(0);
    });


    test('cleanupOldData should delete old events', async () => {
        const events = [
            { aggregationKey: 'test1', data: 'data1' },
            { aggregationKey: 'test2', data: 'data2' },
            { aggregationKey: 'test3', data: 'data3' },
            { aggregationKey: 'test4', data: 'data4' },
            { aggregationKey: 'test5', data: 'data5' },
        ];

        for (let i = 0; i < events.length; i++) {
            await eventStore.add(events[i]);
        }

        await eventStore.cleanupOldData(3);

        const db = await openDB(eventStore.databaseName, 1);
        const allKeys = await db.getAllKeys('Events');
        expect(allKeys.length).toBe(3);
        expect(allKeys).toEqual([3, 4, 5]);
        const mergeKeys  = await Promise.all(allKeys.map(async key => (await db.get('Events', key)).value.aggregationKey));
        const sortedMergeKeys = mergeKeys.sort();
        expect(sortedMergeKeys).toEqual(['test3', 'test4', 'test5']);
        db.close();
    });

    test('subscribe should add and remove listeners', async () => {
        const listener = jest.fn();
        const unsubscribe = eventStore.subscribe(listener);

        await eventStore.add({ data: 'testData' });
        expect(listener).toHaveBeenCalledTimes(1);

        unsubscribe();
        await eventStore.add( { data: 'testData2' });
        expect(listener).toHaveBeenCalledTimes(1); // listener should not be called again
    });
});

describe('EventRecorder with mocked ui7', () => {
    let eventStore: EventStore<MockMergeableEvent>;
    let mockUuid: jest.Mock;

    beforeAll(async () => {
        jest.doMock('uuid', () => ({
            __esModule: true,
            v7: jest.fn((date: Date) => `mocked-uuid-${date.getTime()}`)
        }));
    });

    beforeEach(async () => {
        jest.resetModules();

        const { EventStore } = await import('./eventStore');
        eventStore = new EventStore('testEventStore1');
        await eventStore.initialize();

        mockUuid = jest.requireMock('uuid').v7;
    });

    afterEach(async() => {
        eventStore.dispose();
        (indexedDB as any)._databases.clear();
    });

    describe('put method', () => {
        it('should successfully put a new item when no conflicting ID exists', async () => {
            mockUuid.mockReturnValue('uuid');
            const testEvent = { aggregationKey: 'event', data: 'test data' };
            await expect(eventStore.add(testEvent)).resolves.not.toThrow();
        });

        it('should throw an error when globalId conflict', async () => {
            mockUuid.mockReturnValue('uuid-1');

            const testEvent = { aggregationKey: 'event', data: 'test data' };

            await expect(eventStore.add(testEvent)).resolves.not.toThrow();
            await expect(eventStore.add(testEvent)).rejects.toThrow();
        });

        it('should throw an error when an item with greater ID already exists', async () => {
            mockUuid.mockReturnValue('uuid-2')
                .mockReturnValueOnce('uuid-1');

            const testEvent = { aggregationKey: 'event', data: 'test data' };

            await expect(eventStore.add(testEvent)).resolves.not.toThrow();
            await expect(eventStore.add(testEvent)).resolves.not.toThrow();
        });
    });
});
