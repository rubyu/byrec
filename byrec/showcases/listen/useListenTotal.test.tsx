import React, {ReactNode} from "react";

import { renderHook, act , waitFor } from '@testing-library/react';
import {ListenEventContextProvider, useListenEvent} from './useListenTotal';
import {EventStore} from "../../eventStore";

const genWrapper = (keys: string[]) => {
    const wrapper = ({children}: { children: ReactNode }) => (
        <ListenEventContextProvider keys={keys}>{children}</ListenEventContextProvider>
    );
    return wrapper;
};

describe('useListenEvent', () => {
    beforeEach( () => {
        (indexedDB as any)._databases.clear();
    });

    it('should initialize with loading state', () => {
        const wrapper = genWrapper(['item1', 'item2']);
        const { result } = renderHook(() => useListenEvent(), { wrapper });

        expect(result.current.isInitializing).toBe(true);
        expect(result.current.isSyncing).toBe(false);
        expect(result.current.error).toBe(null);
        expect(result.current.aggregatedValues).toEqual({});
    });

    it('should fetch initial data and set loading state', async () => {
        const itemIds = ['item1', 'item2'];

        const wrapper = genWrapper(itemIds);
        const { result  } = renderHook(() => useListenEvent(), {
            wrapper,
        });

        await waitFor(() => expect(result.current.isInitializing).toBe(false));
        await waitFor(() => expect(result.current.isSyncing).toBe(false));

        await act(async () => {
            await result.current.addEvent({ itemId: 'item1' });
            await result.current.addEvent({ itemId: 'item2' });
        });

        await waitFor(() => expect(result.current.aggregatedValues).toEqual({
            item1 : { aggregationKey: 'item1', total: 1 },
            item2 : { aggregationKey: 'item2', total: 1 },
        }));
        expect(result.current.error).toBe(null);
    });

    it('should update totals after adding events', async () => {
        const wrapper = genWrapper(['item1', 'item2']);
        const { result } = renderHook(() => useListenEvent(), { wrapper });

        await waitFor(() => expect(result.current.isInitializing).toBe(false));
        await waitFor(() => expect(result.current.isSyncing).toBe(false));

        await act(async () => {
            await result.current.addEvent({ itemId: 'item1' });
            await result.current.addEvent({ itemId: 'item2' });
        });

        await waitFor(() => expect(result.current.aggregatedValues).toEqual({
            item1: {aggregationKey: 'item1', total: 1},
            item2: {aggregationKey: 'item2', total: 1},
        }));
    });

    it('should update syncing state after fetching totals', async () => {
        const wrapper = genWrapper(['item1', 'item2']);
        const { result } = renderHook(() => useListenEvent(), { wrapper });

        await waitFor(() => expect(result.current.isInitializing).toBe(false));
        await waitFor(() => expect(result.current.isSyncing).toBe(false));
    });

    it('should handle adding events for new keys', async () => {
        const wrapper = genWrapper(['item1']);
        const { result } = renderHook(() => useListenEvent(), { wrapper });

        await waitFor(() => expect(result.current.isInitializing).toBe(false));
        await waitFor(() => expect(result.current.isSyncing).toBe(false));

        await act(async () => {
            await result.current.addEvent({ itemId: 'item1' });
            await result.current.addEvent({ itemId: 'item2' });
        });

        await waitFor(() => expect(result.current.aggregatedValues).toEqual({
            item1 : { aggregationKey: 'item1', total: 1 },
            item2 : { aggregationKey: 'item2', total: 1 },
        }));
    });
});
