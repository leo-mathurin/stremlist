/**
 * Module fakes for the Trakt adapter tests. The test files hand them to
 * `vi.mock` factories, so this module must not import the adapter.
 */
import type * as HttpModule from "../../http";

// The real limiters would make the tests wait (1 write per second, a burst
// cap on public reads); their behavior is not under test here.
export function httpModule(original: typeof HttpModule) {
  class NoWaitLimiter {
    acquire(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { ...original, RateLimiter: NoWaitLimiter };
}
