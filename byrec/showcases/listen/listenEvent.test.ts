import { MusicListenEventStore, MusicListenEventAggregator, MusicListenEvent } from './listenEvent';

describe('MusicListenEventAggregator', () => {
    let eventStore: MusicListenEventStore;
    let aggregator: MusicListenEventAggregator;

    beforeEach(async () => {
        indexedDB.deleteDatabase('TestMusicListenEvents');
        indexedDB.deleteDatabase('TestMusicListenAggregator');

        eventStore = new MusicListenEventStore('TestMusicListenEvents');
        aggregator = new MusicListenEventAggregator(eventStore, 'TestMusicListenAggregator');
        await eventStore.initialize();
        await aggregator.initialize();
    });

    afterEach(() => {
        aggregator.dispose();
        eventStore.dispose();
    });

    it('should initialize correctly', () => {
        expect(aggregator).toBeDefined();
    });

    it('should process events and aggregate totals', async () => {
        const event1: MusicListenEvent = { itemId: 'song1' };
        const event2: MusicListenEvent = { itemId: 'song2' };
        const event3: MusicListenEvent = { itemId: 'song1' };

        await eventStore.add(event1);
        await eventStore.add(event2);
        await eventStore.add(event3);

        await new Promise(resolve => setTimeout(resolve, 100));

        const result = await aggregator.getAggregated(['song1', 'song2', 'song3']);
        expect(result).toEqual({
            song1: { aggregationKey: "song1", total: 2},
            song2: { aggregationKey: "song2", total: 1},
            song3: { aggregationKey: "song3", total: 0},
        });
    });

    it('should handle empty input', async () => {
        const result = await aggregator.getAggregated([]);
        expect(result).toEqual({});
    });

    it('should handle non-existent items', async () => {
        const result = await aggregator.getAggregated(['nonexistent']);
        expect(result).toEqual({
            nonexistent: { aggregationKey: "nonexistent", total: 0}
        });
    });

    it('should handle database errors', async () => {
        aggregator.dispose();

        await expect(aggregator.getAggregated(['song1']))
            .rejects.toThrow();
    });

    it('should process events in batches', async () => {
        const events = Array.from({ length: 150 }, (_, i) => ({
            itemId: `song${i % 3}`,
            total: 1
        }));

        for (const event of events) {
            await eventStore.add(event);
        }

        await new Promise(resolve => setTimeout(resolve, 100));

        const result = await aggregator.getAggregated(['song0', 'song1', 'song2']);
        expect(result).toEqual({
            song0: { aggregationKey: "song0", total: 50 },
            song1: { aggregationKey: "song1", total: 50 },
            song2: { aggregationKey: "song2", total: 50 },
        });
    });
});
