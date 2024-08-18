import { Aggregatable, StoredEvent } from "@/lib/byrec/types";
import { EventAggregator } from './eventAggregator';
import { EventStore } from './eventStore';

interface MockMergeableEvent extends Aggregatable {
    data: string;
}

interface MockAggregationValue {
    aggregationKey: string;
}

class NullAggregator extends EventAggregator<MockMergeableEvent, MockAggregationValue> {
    protected applyMigrations(db: IDBDatabase, oldVersion: number, newVersion: number): void {}
    protected async processEvent(trx: IDBTransaction, event: StoredEvent<MockMergeableEvent>): Promise<MockAggregationValue> {
        return Promise.resolve({ aggregationKey: "key" });
    }
    getAggregated(itemIds: string[]): Promise<{ [p: string]: MockAggregationValue }> {
        return Promise.resolve({});
    }
}

async function addMultipleEvents(
    eventStore: EventStore<MockMergeableEvent>,
    count: number
): Promise<void> {
    for (let i = 0; i < count; i++) {
        await eventStore.add({ data: `test${i}` });
    }
}

describe('EventAggregator', () => {
    let eventStore: EventStore<MockMergeableEvent>;
    let eventAggregator: EventAggregator<MockMergeableEvent, MockAggregationValue>;

    beforeEach(async () => {
        const { EventStore } = await import('./eventStore');
        const { EventAggregator } = await import('./eventAggregator');

        eventStore = new EventStore('testEventStore0');
        await eventStore.initialize();
        eventAggregator = new NullAggregator(eventStore, "testEventAggregator0", 10, 1000);
        await eventAggregator.initialize();
    });

    afterEach(async () => {
        jest.useRealTimers();
        eventStore.dispose();
        eventAggregator.dispose();
        (indexedDB as any)._databases.clear();
    });

    describe('Initialization and Subscription', () => {
        test('should subscribe to eventStore on creation',  async() => {
            const subscribeSpy = jest.spyOn(eventStore, 'subscribe');

            eventAggregator.dispose();
            const agg = new NullAggregator(eventStore, "testEventAggregator0_testEventAggregator0");
            await agg.initialize();
            try {
                expect(subscribeSpy).toHaveBeenCalled();
            } finally {
                agg.dispose();
                indexedDB.deleteDatabase('testEventAggregator0_testEventAggregator0');
            }
        });
    });

    describe('Event Processing', () => {
        test('should call processEvent for each new event added to the store', async () => {
            const processEventSpy = jest.spyOn(eventAggregator as any, 'processEvent');

            await eventStore.add({ data: 'test1' });
            await eventStore.add({ data: 'test2' });

            expect(processEventSpy).toHaveBeenCalledTimes(2);
        });

        test('handleNewEvent should process event and update processed ranges', async () => {
            const processEventSpy = jest.spyOn(eventAggregator as any, 'processEvent');
            const updateProcessedRangesSpy = jest.spyOn(eventAggregator as any, 'updateProcessedRanges');

            const event: StoredEvent<MockMergeableEvent> = { localId: 1, globalId: 'testKey', value: { data: 'testData' } };
            await (eventAggregator as any).handleNewEvent(event);

            expect(processEventSpy).toHaveBeenCalledWith(expect.anything(), event);
            expect(updateProcessedRangesSpy).toHaveBeenCalledWith(1, 1);
        });

        test('should log error if processing fails', async () => {
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
            const processEventSpy = jest.spyOn(eventAggregator as any, 'processEvent').mockImplementation(() => {throw new Error('Processing error')});

            const event: StoredEvent<MockMergeableEvent> = { localId: 1, globalId: 'test1', value: { data: 'testData' } };
            await (eventAggregator as any).handleNewEvent(event);

            expect(processEventSpy).toHaveBeenCalledTimes(1);
            expect(consoleErrorSpy).toHaveBeenCalledWith('Error processing new event:', expect.any(Error));
        });
    });

    describe('Batch Processing', () => {
        beforeEach(() => {
            // Reset the processed ranges before each test
            (eventAggregator as any).processedRanges = [];
        });

        test('processEvents should process events in batch and stop when all events are processed', async () => {
            const mockEvents = [
                { localId: 5, globalId: 'test5', value: { aggregationKey: 'test', data: 'test5' } },
                { localId: 4, globalId: 'test4', value: { aggregationKey: 'test', data: 'test4' } },
                { localId: 3, globalId: 'test3', value: { aggregationKey: 'test', data: 'test3' } },
                { localId: 2, globalId: 'test2', value: { aggregationKey: 'test', data: 'test2' } },
                { localId: 1, globalId: 'test1', value: { aggregationKey: 'test', data: 'test1' } },
            ];

            const findRangeToProcessSpy = jest.spyOn(eventAggregator as any, 'findRangeToProcess')
                .mockReturnValueOnce({ start: 0, end: 5 })
                .mockReturnValueOnce(null);

            const getEventsBeforeSpy = jest.spyOn(eventStore, 'getEventsBefore')
                .mockResolvedValueOnce(mockEvents);

            const processEventSpy = jest.spyOn(eventAggregator as any, 'processEvent')
                .mockResolvedValue(undefined);

            const isFullyCoveredSpy = jest.spyOn(eventAggregator as any, 'isFullyCovered')
                .mockReturnValueOnce(false)
                .mockReturnValueOnce(true);

            await (eventAggregator as any).processEvents();

            expect(findRangeToProcessSpy).toHaveBeenCalledTimes(1);
            expect(getEventsBeforeSpy).toHaveBeenCalledWith(5, { limit: 4 });
            expect(processEventSpy).toHaveBeenCalledTimes(5);
            expect(isFullyCoveredSpy).toHaveBeenCalledTimes(1);
            expect((eventAggregator as any).processedRanges).toEqual([{ start: 1, end: 5 }]);
        });

        test('processEvents should stop processing when isFullyCovered returns true', async () => {
            const isFullyCoveredSpy = jest.spyOn(eventAggregator as any, 'isFullyCovered')
                .mockReturnValueOnce(true);

            const stopProcessingSpy = jest.spyOn(eventAggregator, 'stopProcessing');

            await (eventAggregator as any).processEvents();

            expect(isFullyCoveredSpy).toHaveBeenCalledTimes(1);
            expect(stopProcessingSpy).toHaveBeenCalled();
        });

        test('should not process events if already processing', async () => {
            const isFullyCoveredSpy = jest.spyOn(eventAggregator as any, 'isFullyCovered');
            const findRangeToProcessSpy = jest.spyOn(eventAggregator as any, 'findRangeToProcess');

            await (eventAggregator as any).processEvents();

            expect(isFullyCoveredSpy).toHaveBeenCalled();
            expect(findRangeToProcessSpy).toHaveBeenCalled();
        });

        test('should process events and update ranges when events are found', async () => {
            const mockEvents = [
                { localId: 3, globalId: 'test3', value: { aggregationKey: 'test', data: 'testData3' } },
                { localId: 2, globalId: 'test2', value: { aggregationKey: 'test', data: 'testData2' } },
                { localId: 1, globalId: 'test1', value: { aggregationKey: 'test', data: 'testData1' } },
            ];
            jest.spyOn(eventAggregator as any, 'findRangeToProcess').mockReturnValue({ start: 0, end: 10 });
            jest.spyOn(eventStore, 'getEventsBefore').mockResolvedValue(mockEvents);
            const processEventSpy = jest.spyOn(eventAggregator as any, 'processEvent').mockResolvedValue(undefined);
            const updateProcessedRangesSpy = jest.spyOn(eventAggregator as any, 'updateProcessedRanges');

            await (eventAggregator as any).processEvents();

            expect(processEventSpy).toHaveBeenCalledTimes(3);
            expect(updateProcessedRangesSpy).toHaveBeenCalledWith(1, 3);
        });
    });

    describe('Processing Control', () => {
        test('should start and stop processing at specified intervals', () => {
            jest.useFakeTimers();

            const processEventsSpy = jest.spyOn(eventAggregator as any, 'processEvents');

            eventAggregator.startProcessing();
            jest.advanceTimersByTime(3500);

            expect(processEventsSpy).toHaveBeenCalledTimes(3);

            eventAggregator.stopProcessing();
            jest.advanceTimersByTime(2000);

            expect(processEventsSpy).toHaveBeenCalledTimes(3);
        });

        test('should not start processing if already started', () => {
            jest.useFakeTimers();
            const setIntervalSpy = jest.spyOn(global, 'setInterval');

            eventAggregator.startProcessing();
            eventAggregator.startProcessing();

            expect(setIntervalSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('Range Management', () => {
        describe('findRangeToProcess', () => {
            test('should return first unprocessed range', () => {
                (eventAggregator as any).processedRanges = [
                    { start: 1, end: 3 },
                    { start: 5, end: 7 }
                ];

                const result = (eventAggregator as any).findRangeToProcess();
                expect(result).resolves.toEqual({ start: 3, end: 5 });
            });

            test('should return null when processedRanges is empty', () => {
                (eventAggregator as any).processedRanges = [];
                expect((eventAggregator as any).findRangeToProcess()).resolves.toEqual({ start: 0, end: Number.MAX_SAFE_INTEGER });
            });

            test('should return null when the only range starts at 0', () => {
                (eventAggregator as any).processedRanges = [{ start: 1, end: 10 }];
                expect((eventAggregator as any).findRangeToProcess()).resolves.toBeNull();
            });

            test('should return correct range when there is one processed range', () => {
                (eventAggregator as any).processedRanges = [{ start: 5, end: 10 }];
                expect((eventAggregator as any).findRangeToProcess()).resolves.toEqual({ start: 0, end: 5 });
            });

            test('should return correct range when there are multiple processed ranges', () => {
                (eventAggregator as any).processedRanges = [
                    { start: 0, end: 5 },
                    { start: 10, end: 15 },
                    { start: 20, end: 25 }
                ];
                expect((eventAggregator as any).findRangeToProcess()).resolves.toEqual({ start: 15, end: 20 });
            });
        });

        describe('isFullyCovered', () => {
            test('should return true when processed range covers entire valid range', () => {
                (eventAggregator as any).processedRanges = [
                    { start: 0, end: Number.MAX_SAFE_INTEGER }
                ];

                expect((eventAggregator as any).isFullyCovered()).toBe(true);
            });

            test('should return false when processedRanges is empty', () => {
                (eventAggregator as any).processedRanges = [];
                expect((eventAggregator as any).isFullyCovered()).toBe(false);
            });

            test('should return true when there is one range starting from 0', () => {
                (eventAggregator as any).processedRanges = [{ start: 0, end: 10 }];
                expect((eventAggregator as any).isFullyCovered()).toBe(true);
            });

            test('should return false when there is one range not starting from 0', () => {
                (eventAggregator as any).processedRanges = [{ start: 1, end: 10 }];
                expect((eventAggregator as any).isFullyCovered()).toBe(false);
            });

            test('should return false when there are multiple ranges', () => {
                (eventAggregator as any).processedRanges = [
                    { start: 0, end: 5 },
                    { start: 6, end: 10 }
                ];
                expect((eventAggregator as any).isFullyCovered()).toBe(false);
            });
        });

        describe('updateProcessedRanges', () => {
            test('should merge overlapping ranges', () => {
                (eventAggregator as any).processedRanges = [
                    { start: 1, end: 3 },
                    { start: 5, end: 7 }
                ];

                (eventAggregator as any).updateProcessedRanges(2, 6);

                expect((eventAggregator as any).processedRanges).toEqual([
                    { start: 1, end: 7 }
                ]);
            });

            test('should add new range when processedRanges is empty', () => {
                (eventAggregator as any).updateProcessedRanges(1, 5);
                expect((eventAggregator as any).processedRanges).toEqual([{ start: 1, end: 5 }]);
            });

            test('should merge adjacent ranges', () => {
                (eventAggregator as any).processedRanges = [{ start: 1, end: 3 }, { start: 7, end: 9 }];
                (eventAggregator as any).updateProcessedRanges(4, 6);
                expect((eventAggregator as any).processedRanges).toEqual([{ start: 1, end: 9 }]);
            });

            test('should not merge non-overlapping, non-adjacent ranges', () => {
                (eventAggregator as any).processedRanges = [{ start: 1, end: 3 }, { start: 7, end: 9 }];
                (eventAggregator as any).updateProcessedRanges(5, 5);
                expect((eventAggregator as any).processedRanges).toEqual([
                    { start: 1, end: 3 },
                    { start: 5, end: 5 },
                    { start: 7, end: 9 }
                ]);
            });

            test('should handle a new range that encompasses all existing ranges', () => {
                (eventAggregator as any).processedRanges = [{ start: 2, end: 4 }, { start: 6, end: 8 }];
                (eventAggregator as any).updateProcessedRanges(1, 10);
                expect((eventAggregator as any).processedRanges).toEqual([{ start: 1, end: 10 }]);
            });
        });
    });

    describe('Error Handling', () => {
        test('should handle errors during event processing', async () => {
            const errorEvent: StoredEvent<MockMergeableEvent> = {
                localId: 1,
                globalId: 'error',
                value: { data: 'errorData' }
            };
            const processEventSpy = jest.spyOn(eventAggregator as any, 'processEvent').mockImplementation(() => {throw new Error('Processing error')});
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

            await (eventAggregator as any).handleNewEvent(errorEvent);

            expect(processEventSpy).toHaveBeenCalledWith(expect.anything(), errorEvent);
            expect(consoleErrorSpy).toHaveBeenCalledWith('Error processing new event:', expect.any(Error));
        });
    });

    describe('Edge Cases', () => {
        test('should handle empty event store', async () => {
            (eventAggregator as any).processedRanges = [{ start: 1000, end: 1000 }];
            jest.spyOn(eventStore, 'getEventsBefore').mockResolvedValue([]);
            const updateProcessedRangesSpy = jest.spyOn(eventAggregator as any, 'updateProcessedRanges');

            await (eventAggregator as any).processEvents();

            expect(updateProcessedRangesSpy).not.toHaveBeenCalled();
        });

        test('should handle maximum safe integer as event ID', async () => {
            const maxEvent: StoredEvent<MockMergeableEvent> = {
                localId: Number.MAX_SAFE_INTEGER,
                globalId: 'max',
                value: { data: 'maxData' }
            };
            const updateProcessedRangesSpy = jest.spyOn(eventAggregator as any, 'updateProcessedRanges');

            await (eventAggregator as any).handleNewEvent(maxEvent);

            expect(updateProcessedRangesSpy).toHaveBeenCalledWith(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
        });

        test('should handle events with duplicate localIds', async () => {
            const event1: StoredEvent<MockMergeableEvent> = { localId: 1, globalId: 'test1', value: { data: 'testData1' } };
            const event2: StoredEvent<MockMergeableEvent> = { localId: 1, globalId: 'test2', value: { data: 'testData2' } };

            await (eventAggregator as any).handleNewEvent(event1);
            await (eventAggregator as any).handleNewEvent(event2);

            expect((eventAggregator as any).processedRanges).toEqual([{ start: 1, end: 1 }]);
        });
    });

    describe('Performance', () => {
        test('should handle large number of events efficiently', async () => {
            (eventAggregator as any).processedRanges = [{ start: 10001, end: 10001 }];
            const largeNumberOfEvents = 10000;
            const mockEvents = Array.from({ length: largeNumberOfEvents }, (_, i) => ({
                localId: i + 1,
                globalId: `test${i + 1}`,
                value: { aggregationKey: 'test', data: `testData${i + 1}` }
            }));

            jest.spyOn(eventStore, 'getEventsBefore').mockResolvedValue(mockEvents);
            const processEventSpy = jest.spyOn(eventAggregator as any, 'processEvent').mockResolvedValue(undefined);

            const startTime = Date.now();
            await (eventAggregator as any).processEvents();
            const endTime = Date.now();

            expect(processEventSpy).toHaveBeenCalledTimes(largeNumberOfEvents);
            expect(endTime - startTime).toBeLessThan(5000); // Assuming processing should take less than 5 seconds
        });
    });
});

describe('EventAggregator - delayed deploy', () => {
    let eventStore: EventStore<MockMergeableEvent>;
    let eventAggregator: EventAggregator<MockMergeableEvent, MockAggregationValue>;

    beforeEach(async () => {
        const { EventStore } = await import('./eventStore');
        eventStore = new EventStore('testEventStore1');
        await eventStore.initialize();
        await addMultipleEvents(eventStore, 5);

        const { EventAggregator } = await import('./eventAggregator');
        eventAggregator = new NullAggregator(eventStore, "testEventAggregator1", 10, 1000);
        await eventAggregator.initialize();
    });

    afterEach(async () => {
        jest.useRealTimers();
        eventStore.dispose();
        eventAggregator.dispose();
        indexedDB.deleteDatabase('testEventStore1');
        indexedDB.deleteDatabase('testEventAggregator1');
    });

    describe('Initialization and Subscription', () => {
        test('should subscribe to eventStore on creation',  async() => {
            const subscribeSpy = jest.spyOn(eventStore, 'subscribe');

            eventAggregator.dispose();
            const agg = new NullAggregator(eventStore, "testEventAggregator0");
            await agg.initialize();
            try {
                expect(subscribeSpy).toHaveBeenCalled();
            } finally {
                agg.dispose();
                indexedDB.deleteDatabase('testEventAggregator0');
            }
        });
    });

    describe('Event Processing', () => {
        test('should call processEvent for each new event added to the store', async () => {
            const processEventSpy = jest.spyOn(eventAggregator as any, 'processEvent');

            await eventStore.add({ data: 'test1' });
            await eventStore.add({ data: 'test2' });

            expect(processEventSpy).toHaveBeenCalledTimes(2);
        });

        test('handleNewEvent should process event and update processed ranges', async () => {
            const processEventSpy = jest.spyOn(eventAggregator as any, 'processEvent');
            const updateProcessedRangesSpy = jest.spyOn(eventAggregator as any, 'updateProcessedRanges');

            const event: StoredEvent<MockMergeableEvent> = { localId: 1, globalId: 'testKey', value: { data: 'testData' } };
            await (eventAggregator as any).handleNewEvent(event);

            expect(processEventSpy).toHaveBeenCalledWith(expect.anything(), event);
            expect(updateProcessedRangesSpy).toHaveBeenCalledWith(1, 1);
        });

        test('should log error if processing fails', async () => {
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
            const processEventSpy = jest.spyOn(eventAggregator as any, 'processEvent').mockImplementation(() => {throw new Error('Processing error')});

            const event: StoredEvent<MockMergeableEvent> = { localId: 1, globalId: 'test1', value: { data: 'testData' } };
            await (eventAggregator as any).handleNewEvent(event);

            expect(processEventSpy).toHaveBeenCalledTimes(1);
            expect(consoleErrorSpy).toHaveBeenCalledWith('Error processing new event:', expect.any(Error));
        });
    });

    describe('Batch Processing', () => {
        test('processEvents should process events in batch and stop when all events are processed', async () => {
            const processEventSpy = jest.spyOn(eventAggregator as any, 'processEvent')
                .mockResolvedValue(undefined);

            await (eventAggregator as any).processEvents();

            expect(processEventSpy).toHaveBeenCalledTimes(5);
            expect((eventAggregator as any).processedRanges).toEqual([{ start: 1, end: 5 }]);
        });

        test('processEvents should stop processing when isFullyCovered returns true', async () => {
            const isFullyCoveredSpy = jest.spyOn(eventAggregator as any, 'isFullyCovered')
                .mockReturnValueOnce(true);

            const stopProcessingSpy = jest.spyOn(eventAggregator, 'stopProcessing');

            await (eventAggregator as any).processEvents();

            expect(isFullyCoveredSpy).toHaveBeenCalledTimes(1);
            expect(stopProcessingSpy).toHaveBeenCalled();
        });

        test('should update processed ranges when no events are found', async () => {
            jest.spyOn(eventAggregator as any, 'findRangeToProcess').mockReturnValue({ start: 0, end: 10 });
            jest.spyOn(eventStore, 'getEventsBefore').mockResolvedValue([]);
            const updateProcessedRangesSpy = jest.spyOn(eventAggregator as any, 'updateProcessedRanges');

            await (eventAggregator as any).processEvents();

            expect(updateProcessedRangesSpy).not.toHaveBeenCalled();
        });

        test('should process events and update ranges when events are found', async () => {
            const mockEvents = [
                { localId: 3, globalId: 'test3', value: { aggregationKey: 'test', data: 'testData3' } },
                { localId: 2, globalId: 'test2', value: { aggregationKey: 'test', data: 'testData2' } },
                { localId: 1, globalId: 'test1', value: { aggregationKey: 'test', data: 'testData1' } },
            ];
            jest.spyOn(eventAggregator as any, 'findRangeToProcess').mockReturnValue({ start: 0, end: 10 });
            jest.spyOn(eventStore, 'getEventsBefore').mockResolvedValue(mockEvents);
            const processEventSpy = jest.spyOn(eventAggregator as any, 'processEvent').mockResolvedValue(undefined);
            const updateProcessedRangesSpy = jest.spyOn(eventAggregator as any, 'updateProcessedRanges');

            await (eventAggregator as any).processEvents();

            expect(processEventSpy).toHaveBeenCalledTimes(3);
            expect(updateProcessedRangesSpy).toHaveBeenCalledWith(1, 3);
        });
    });

    describe('Processing Control', () => {
        test('should start and stop processing at specified intervals', () => {
            jest.useFakeTimers();

            const processEventsSpy = jest.spyOn(eventAggregator as any, 'processEvents');

            eventAggregator.startProcessing();
            jest.advanceTimersByTime(3500);

            expect(processEventsSpy).toHaveBeenCalledTimes(3);

            eventAggregator.stopProcessing();
            jest.advanceTimersByTime(2000);

            expect(processEventsSpy).toHaveBeenCalledTimes(3);
        });

        test('should not start processing if already started', () => {
            jest.useFakeTimers();
            const setIntervalSpy = jest.spyOn(global, 'setInterval');

            eventAggregator.startProcessing();
            eventAggregator.startProcessing();

            expect(setIntervalSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('Range Management', () => {
        describe('findRangeToProcess', () => {
            test('should return first unprocessed range', () => {
                (eventAggregator as any).processedRanges = [
                    { start: 1, end: 3 },
                    { start: 5, end: 7 }
                ];

                const result = (eventAggregator as any).findRangeToProcess();
                expect(result).resolves.toEqual({ start: 3, end: 5 });
            });

            test('should return null when processedRanges is empty', () => {
                (eventAggregator as any).processedRanges = [];
                expect((eventAggregator as any).findRangeToProcess()).resolves.toEqual({"start": 0, "end": Number.MAX_SAFE_INTEGER });
            });

            test('should return null when the only range starts at 0', () => {
                (eventAggregator as any).processedRanges = [{ start: 1, end: 10 }];
                expect((eventAggregator as any).findRangeToProcess()).resolves.toBeNull();
            });

            test('should return correct range when there is one processed range', () => {
                (eventAggregator as any).processedRanges = [{ start: 5, end: 10 }];
                expect((eventAggregator as any).findRangeToProcess()).resolves.toEqual({ start: 0, end: 5 });
            });

            test('should return correct range when there are multiple processed ranges', () => {
                (eventAggregator as any).processedRanges = [
                    { start: 0, end: 5 },
                    { start: 10, end: 15 },
                    { start: 20, end: 25 }
                ];
                expect((eventAggregator as any).findRangeToProcess()).resolves.toEqual({ start: 15, end: 20 });
            });
        });

        describe('isFullyCovered', () => {
            test('should return true when processed range covers entire valid range', () => {
                (eventAggregator as any).processedRanges = [
                    { start: 0, end: Number.MAX_SAFE_INTEGER }
                ];

                expect((eventAggregator as any).isFullyCovered()).toBe(true);
            });

            test('should return false when processedRanges is empty', () => {
                (eventAggregator as any).processedRanges = [];
                expect((eventAggregator as any).isFullyCovered()).toBe(false);
            });

            test('should return true when there is one range starting from 0', () => {
                (eventAggregator as any).processedRanges = [{ start: 0, end: 10 }];
                expect((eventAggregator as any).isFullyCovered()).toBe(true);
            });

            test('should return false when there is one range not starting from 0', () => {
                (eventAggregator as any).processedRanges = [{ start: 1, end: 10 }];
                expect((eventAggregator as any).isFullyCovered()).toBe(false);
            });

            test('should return false when there are multiple ranges', () => {
                (eventAggregator as any).processedRanges = [
                    { start: 0, end: 5 },
                    { start: 6, end: 10 }
                ];
                expect((eventAggregator as any).isFullyCovered()).toBe(false);
            });
        });

        describe('updateProcessedRanges', () => {
            test('should merge overlapping ranges', () => {
                (eventAggregator as any).processedRanges = [
                    { start: 1, end: 3 },
                    { start: 5, end: 7 }
                ];

                (eventAggregator as any).updateProcessedRanges(2, 6);

                expect((eventAggregator as any).processedRanges).toEqual([
                    { start: 1, end: 7 }
                ]);
            });

            test('should add new range when processedRanges is empty', () => {
                (eventAggregator as any).updateProcessedRanges(1, 5);
                expect((eventAggregator as any).processedRanges).toEqual([{ start: 1, end: 5 }]);
            });

            test('should merge adjacent ranges', () => {
                (eventAggregator as any).processedRanges = [{ start: 1, end: 3 }, { start: 7, end: 9 }];
                (eventAggregator as any).updateProcessedRanges(4, 6);
                expect((eventAggregator as any).processedRanges).toEqual([{ start: 1, end: 9 }]);
            });

            test('should not merge non-overlapping, non-adjacent ranges', () => {
                (eventAggregator as any).processedRanges = [{ start: 1, end: 3 }, { start: 7, end: 9 }];
                (eventAggregator as any).updateProcessedRanges(5, 5);
                expect((eventAggregator as any).processedRanges).toEqual([
                    { start: 1, end: 3 },
                    { start: 5, end: 5 },
                    { start: 7, end: 9 }
                ]);
            });

            test('should handle a new range that encompasses all existing ranges', () => {
                (eventAggregator as any).processedRanges = [{ start: 2, end: 4 }, { start: 6, end: 8 }];
                (eventAggregator as any).updateProcessedRanges(1, 10);
                expect((eventAggregator as any).processedRanges).toEqual([{ start: 1, end: 10 }]);
            });
        });
    });

    describe('Error Handling', () => {
        test('should handle errors during event processing', async () => {
            const errorEvent: StoredEvent<MockMergeableEvent> = {
                localId: 1,
                globalId: 'error',
                value: { data: 'errorData' }
            };
            const processEventSpy = jest.spyOn(eventAggregator as any, 'processEvent').mockImplementation(() => {throw new Error('Processing error')});
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

            await (eventAggregator as any).handleNewEvent(errorEvent);

            expect(processEventSpy).toHaveBeenCalledWith(expect.anything(), errorEvent);
            expect(consoleErrorSpy).toHaveBeenCalledWith('Error processing new event:', expect.any(Error));
        });
    });

    describe('Edge Cases', () => {
        test('should handle empty event store', async () => {
            (eventAggregator as any).processedRanges = [{ start: 1000, end: 1000 }];
            jest.spyOn(eventStore, 'getEventsBefore').mockResolvedValue([]);
            const updateProcessedRangesSpy = jest.spyOn(eventAggregator as any, 'updateProcessedRanges');

            await (eventAggregator as any).processEvents();

            expect(updateProcessedRangesSpy).not.toHaveBeenCalled();
        });

        test('should handle maximum safe integer as event ID', async () => {
            const maxEvent: StoredEvent<MockMergeableEvent> = {
                localId: Number.MAX_SAFE_INTEGER,
                globalId: 'max',
                value: { data: 'maxData' }
            };
            const updateProcessedRangesSpy = jest.spyOn(eventAggregator as any, 'updateProcessedRanges');

            await (eventAggregator as any).handleNewEvent(maxEvent);

            expect(updateProcessedRangesSpy).toHaveBeenCalledWith(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
        });

        test('should handle events with duplicate localIds', async () => {
            const event1: StoredEvent<MockMergeableEvent> = { localId: 1, globalId: 'test1', value: { data: 'testData1' } };
            const event2: StoredEvent<MockMergeableEvent> = { localId: 1, globalId: 'test2', value: { data: 'testData2' } };

            await (eventAggregator as any).handleNewEvent(event1);
            await (eventAggregator as any).handleNewEvent(event2);

            expect((eventAggregator as any).processedRanges).toEqual([{ start: 1, end: 1 }]);
        });
    });

    describe('Performance', () => {
        test('should handle large number of events efficiently', async () => {
            (eventAggregator as any).processedRanges = [{ start: 10001, end: 10001 }];
            const largeNumberOfEvents = 10000;
            const mockEvents = Array.from({ length: largeNumberOfEvents }, (_, i) => ({
                localId: i + 1,
                globalId: `test${i + 1}`,
                value: { aggregationKey: 'test', data: `testData${i + 1}` }
            }));

            jest.spyOn(eventStore, 'getEventsBefore').mockResolvedValue(mockEvents);
            const processEventSpy = jest.spyOn(eventAggregator as any, 'processEvent').mockResolvedValue(undefined);

            const startTime = Date.now();
            await (eventAggregator as any).processEvents();
            const endTime = Date.now();

            expect(processEventSpy).toHaveBeenCalledTimes(largeNumberOfEvents);
            expect(endTime - startTime).toBeLessThan(5000); // Assuming processing should take less than 5 seconds
        });
    });
});
