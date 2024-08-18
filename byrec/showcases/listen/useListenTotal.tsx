'use client';
import React from 'react';
import {
    MusicListenAggregationValue,
    MusicListenEvent,
    MusicListenEventAggregator,
    MusicListenEventStore
} from './listenEvent';
import createGenericEventProvider from "../../useEvent";

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
