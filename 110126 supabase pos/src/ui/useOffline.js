import { useSyncExternalStore } from 'react';
import { offline } from '../data/offline/manager.js';

/** The live offline status (online or not, how many sales are waiting...). Re-renders the screen when it changes. */
export function useOffline() {
  return useSyncExternalStore(offline.subscribe, offline.getState, offline.getState);
}
