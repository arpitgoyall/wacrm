'use client';

import { useSyncExternalStore } from 'react';

let currentTime: number | null = null;
const listeners = new Set<() => void>();

function refresh() {
  currentTime = Date.now();
  listeners.forEach((listener) => listener());
}

function refreshWhenVisible() {
  if (document.visibilityState === 'visible') refresh();
}

let interval: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    refresh();
    // All visible age labels share one clock, even on large boards.
    interval = setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(interval);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      currentTime = null;
    }
  };
}

function getSnapshot() {
  return currentTime;
}

function getServerSnapshot() {
  return null;
}

export function useCurrentTime() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
