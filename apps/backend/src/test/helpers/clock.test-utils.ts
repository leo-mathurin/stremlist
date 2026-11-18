import { vi } from "vite-plus/test";

/** Moves the clock one second on, as when the user acts again a second later. */
export function oneSecondLater() {
  vi.setSystemTime(Date.now() + 1000);
}

/**
 * Runs `operation` on a fake clock that moves from timer to timer until the
 * operation settles, so that rate limiter waits take no real time.
 */
export async function onFakeClock<T>(operation: () => Promise<T>) {
  vi.useFakeTimers({ now: Date.now() });
  const result = operation();
  let settled = false;
  result.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled) await vi.advanceTimersToNextTimerAsync();
  return result;
}
