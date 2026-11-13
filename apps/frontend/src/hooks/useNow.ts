import { useSyncExternalStore } from "react";

/**
 * One clock for the page, ticking once a second while a component reads it.
 * Only the components that show a live time render each second, not the
 * whole page: a page render can take long enough to stall a running
 * animation.
 */
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** The current time, updated once a second. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}
