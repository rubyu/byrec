import { LikeEventStore, LikeEventAggregator, LikeEvent } from './likeEvent';

describe('LikeEventAggregator', () => {
    let eventStore: LikeEventStore;
    let aggregator: LikeEventAggregator;

    beforeEach(async () => {
        indexedDB.deleteDatabase('TestLikeEvents');
        indexedDB.deleteDatabase('TestLikeAggregator');

        eventStore = new LikeEventStore('TestLikeEvents');
        aggregator = new LikeEventAggregator(eventStore, 'TestLikeAggregator');
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

    it('should process events and aggregate like status', async () => {
        const event1: LikeEvent = { itemId: 'song1', isLiked: true };
        const event2: LikeEvent = { itemId: 'song2', isLiked: true };
        const event3: LikeEvent = { itemId: 'song1', isLiked: false };

        await eventStore.add(event1);
        await eventStore.add(event2);
        await eventStore.add(event3);

        await new Promise(resolve => setTimeout(resolve, 100));

        const result = await aggregator.getAggregated(['song1', 'song2', 'song3']);
        expect(result.song1.isLiked).toBe(false);
        expect(result.song2.isLiked).toBe(true);
        expect(result.song3.isLiked).toBe(false);
    });

    it('should handle empty input', async () => {
        const result = await aggregator.getAggregated([]);
        expect(result).toEqual({});
    });

    it('should handle non-existent items', async () => {
        const result = await aggregator.getAggregated(['nonexistent']);
        expect(result.nonexistent.isLiked).toBe(false);
    });

    it('should handle database errors', async () => {
        aggregator.dispose();

        await expect(aggregator.getAggregated(['song1']))
            .rejects.toThrow();
    });

    it('should process events in batches', async () => {
        const events = Array.from({ length: 150 }, (_, i) => ({
            itemId: `song${i % 3}`,
            isLiked: i % 2 === 0
        }));

        for (const event of events) {
            await eventStore.add(event);
        }

        await new Promise(resolve => setTimeout(resolve, 100));

        const event0: LikeEvent = { itemId: 'song0', isLiked: true };
        const event1: LikeEvent = { itemId: 'song1', isLiked: false };
        const event2: LikeEvent = { itemId: 'song2', isLiked: true };

        await eventStore.add(event0);
        await eventStore.add(event1);
        await eventStore.add(event2);

        await new Promise(resolve => setTimeout(resolve, 100));

        const result = await aggregator.getAggregated(['song0', 'song1', 'song2']);
        expect(result.song0.isLiked).toBe(true);
        expect(result.song1.isLiked).toBe(false);
        expect(result.song2.isLiked).toBe(true);
    });

    it('should update like status based on the most recent event', async () => {
        const events: LikeEvent[] = [
            { itemId: 'song1', isLiked: true },
            { itemId: 'song1', isLiked: false },
            { itemId: 'song1', isLiked: true }
        ];

        for (const event of events) {
            await eventStore.add(event);
        }

        await new Promise(resolve => setTimeout(resolve, 100));

        const result = await aggregator.getAggregated(['song1']);
        expect(result.song1.isLiked).toBe(true);
    });

    it('should return correct lastUpdated timestamp', async () => {
        const now = new Date();
        const event: LikeEvent = { itemId: 'song1', isLiked: true };

        await eventStore.add(event);

        await new Promise(resolve => setTimeout(resolve, 100));

        const result = await aggregator.getAggregated(['song1']);
        //expect(result.song1.lastUpdated).toBeInstanceOf(Date);
        const diff = Math.abs(result.song1.lastUpdated.getTime() - now.getTime());
        expect(diff).toBeLessThan(1000);
    });
});
