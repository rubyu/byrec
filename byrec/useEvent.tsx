import React, { createContext, useContext, useState, useEffect, ReactNode, useMemo, useRef } from 'react';
import { EventStore } from "./eventStore";
import { EventAggregator } from "./eventAggregator";
import { Aggregatable, AggregatedValue } from "./types";

type EventContextType<E extends Aggregatable, A extends AggregatedValue<string>> = {
    addEvent: (event: E) => Promise<void>;
    aggregatedValues: { [key: string]: A };
    isInitializing: boolean;
    isSyncing: boolean;
    error: Error | null;
};

type EventContextProps<E extends Aggregatable, A extends AggregatedValue<string>> = {
    keys: string[];
    children: ReactNode;
    EventStore: new (databaseName: string) => EventStore<E>;
    EventAggregator: new (eventStore: EventStore<E>, databaseName: string) => EventAggregator<E, A>;
    eventStoreDatabaseName: string;
    eventAggregatorDatabaseName: string;
};

function createGenericEventProvider<E extends Aggregatable, A extends AggregatedValue<string>>() {
    const EventContext = createContext<EventContextType<E, A> | undefined>(undefined);

    const EventProvider: React.FC<EventContextProps<E, A>> = ({
                                                                  keys,
                                                                  children,
                                                                  EventStore,
                                                                  EventAggregator,
                                                                  eventStoreDatabaseName,
                                                                  eventAggregatorDatabaseName
                                                              }) => {
        const [aggregatedValues, setAggregatedValues] = useState<{ [key: string]: A }>({});
        const [isInitializing, setIsInitializing] = useState(true);
        const [isSyncing, setIsSyncing] = useState(false);
        const [error, setError] = useState<Error | null>(null);

        const { eventStore, aggregator } = useMemo(() => {
            const eventStore = new EventStore(eventStoreDatabaseName);
            const aggregator = new EventAggregator(eventStore, eventAggregatorDatabaseName);
            (async() => {
                await eventStore.initialize();
                await aggregator.initialize();
            })().catch(err => {
                console.error(`Failed to initialize EventStore/Aggregator: ${err}`);
            });
            return { eventStore, aggregator };
        }, []);

        useEffect(() => {
            const handleUpdate = (updated: A) => {
                setAggregatedValues(prevValues => ({
                    ...prevValues,
                    [updated.aggregationKey]: updated
                }));
            };
            const unsubscribe = aggregator.subscribe(handleUpdate);
            return () => {
                if (typeof unsubscribe === 'function') {
                    unsubscribe();
                }
            };
        }, []);

        const [hasBoot, setHasBoot] = useState(false);
        const [bootCount, setBootCount] = useState(0);
        const incrementInitCount = () => setBootCount(prevCount => prevCount + 1);
        const bootTimerRef = useRef<number | null>(null);
        const completeBoot = () => {
            setHasBoot(true);
            if (bootTimerRef.current) {
                clearInterval(bootTimerRef.current);
                bootTimerRef.current = null;
            }
        };

        useEffect(() => {
            bootTimerRef.current = Number(setInterval(() => {
                if (hasBoot) return;
                incrementInitCount();
            }, 100));
            return () => {
                if (bootTimerRef.current) {
                    clearInterval(bootTimerRef.current);
                }
            }
        }, []);

        useEffect(() => {
            if (hasBoot) return;
            if (!eventStore.isInitialized() || !aggregator.isInitialized()) return;
            if (eventStore.isInitializationSucceeded() &&
                aggregator.isInitializationSucceeded()) {
                setIsInitializing(false);
                setIsSyncing(true);
                aggregator.startProcessing();
            } else {
                if (!eventStore.isInitializationSucceeded()) setError(eventStore.getInitializationError());
                if (!aggregator.isInitializationSucceeded()) setError(aggregator.getInitializationError());
                setIsInitializing(false);
                setIsSyncing(false);
            }
            completeBoot();
        }, [bootCount]);

        useEffect(() => {
            if (isInitializing || error != null) return;
            const fetchAggregatedValues = async () => {
                const result = await aggregator.getAggregated(keys);
                if (result != null) {
                    setAggregatedValues(result);
                }
            };
            fetchAggregatedValues().then(() => {
                setIsSyncing(false);
            }).catch(err => {
                setIsSyncing(false);
                setError(err instanceof Error ? err : new Error('Failed to fetch aggregated values'));
            });
        }, [keys, isInitializing]);

        return (
            <EventContext.Provider value={{
                addEvent: eventStore.add.bind(eventStore),
                aggregatedValues,
                isInitializing,
                isSyncing,
                error
            }}>
                {children}
            </EventContext.Provider>
        );
    };

    const useEvent = () => {
        const context = useContext(EventContext);
        if (context === undefined) {
            throw new Error('useEvent must be used within an EventContext');
        }
        return context;
    };

    return { EventProvider, useEvent };
}

export default createGenericEventProvider;
