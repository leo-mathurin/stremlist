import { vi } from "vite-plus/test";

/** Moves the clock one second on, as when the user acts again a second later. */
export function oneSecondLater() {
  vi.setSystemTime(Date.now() + 1000);
}

const MAX_TIMER_JUMPS = 10_000;

/**
 * Runs `operation` on a fake clock that moves from timer to timer until the
 * operation settles, so that rate limiter waits take no real time. It fails
 * with an error when the operation still runs after a fixed number of timer
 * jumps, for example because a handler never answers.
 */
export async function onFakeClock<T>(operation: () => Promise<T>) {
  vi.useFakeTimers({ now: Date.now() });
  const result = operation();
  let settled = false;
  result.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let jump = 0; !settled; jump++) {
    if (jump >= MAX_TIMER_JUMPS) {
      throw new Error(
        `onFakeClock: the operation did not settle after ${MAX_TIMER_JUMPS} timer jumps`,
      );
    }
    await vi.advanceTimersToNextTimerAsync();
  }
  return result;
}
