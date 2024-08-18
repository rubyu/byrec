'use client';
import React from 'react';
import {LikeEvent, LikeEventAggregator, LikeAggregationValue, LikeEventStore} from './likeEvent';
import createGenericEventProvider from "../../useEvent";

const { EventProvider: LikeEventProvider, useEvent: useLikeEvent } = createGenericEventProvider<LikeEvent, LikeAggregationValue>();

export const LikeEventContextProvider: React.FC<{ keys: string[], children: React.ReactNode }> = ({ keys, children }) => (
    <LikeEventProvider
        keys={keys}
        EventStore={LikeEventStore}
        EventAggregator={LikeEventAggregator}
        eventStoreDatabaseName="LikeEvents_V1"
        eventAggregatorDatabaseName="LikeAggregator_V1"
    >
        {children}
    </LikeEventProvider>
);

export { useLikeEvent };
