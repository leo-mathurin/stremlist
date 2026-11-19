import { vi } from "vite-plus/test";

/** Moves the clock one second on, as when the user acts again a second later. */
export function oneSecondLater() {
  vi.setSystemTime(Date.now() + 1000);
}

const MAX_TIMER_JUMPS = 10_000;
const realSetTimeout = globalThis.setTimeout;
const realSetImmediate = globalThis.setImmediate;

/** Whether the test faked the timer functions, not only `Date`. */
export function timersAreFake() {
  return globalThis.setTimeout !== realSetTimeout;
}

/**
 * Waits for `promise` on the fake clock that the test installed, moving from
 * timer to timer, so that timer waits take no real time. It fails with an
 * error when the promise still runs after a fixed number of timer jumps, for
 * example because a handler never answers.
 */
export async function untilSettled<T>(promise: Promise<T>) {
  if (!timersAreFake()) {
    throw new Error("untilSettled needs the fake timers of the test");
  }
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let jump = 0; !settled; jump++) {
    if (jump >= MAX_TIMER_JUMPS) {
      throw new Error(
        `untilSettled: the operation did not settle after ${MAX_TIMER_JUMPS} timer jumps`,
      );
    }
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
    else await new Promise((resolve) => realSetImmediate(resolve));
  }
  return promise;
}

/**
 * Runs `operation` on a new fake clock (see `untilSettled`), so that rate
 * limiter waits take no real time.
 */
export function onFakeClock<T>(operation: () => Promise<T>) {
  vi.useFakeTimers({ now: Date.now() });
  return untilSettled(operation());
}
