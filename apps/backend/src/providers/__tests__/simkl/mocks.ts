/**
 * Module fakes for the Simkl adapter tests. The test files hand them to
 * `vi.mock` factories, so this module must not import the adapter.
 */
import type * as Http from "../../http";

// R2 as an in-memory bucket.
export const r2 = {
  objects: new Map<string, string>(),
  /** R2 unreachable: reads fail with an error other than NoSuchKey. */
  down: false,
};

export const r2Module = {
  getR2Bucket: () => "test-bucket",
  getR2Client: () => ({
    send: (command: {
      constructor: { name: string };
      input: { Key: string; Body?: Uint8Array };
    }) => {
      const { Key, Body } = command.input;
      if (command.constructor.name === "PutObjectCommand") {
        r2.objects.set(Key, Buffer.from(Body ?? []).toString());
        return Promise.resolve({});
      }
      if (r2.down) return Promise.reject(new Error("R2 is down"));
      const value = r2.objects.get(Key);
      if (value === undefined) {
        return Promise.reject(
          Object.assign(new Error("missing"), { name: "NoSuchKey" }),
        );
      }
      return Promise.resolve({
        Body: { transformToString: () => Promise.resolve(value) },
      });
    },
  }),
};

// No real waiting in tests; remember the limits each limiter was built with.
export const limiters: [number, number][] = [];

export function httpModule(actual: typeof Http) {
  class RateLimiter {
    constructor(limit: number, windowMs: number) {
      limiters.push([limit, windowMs]);
    }
    acquire(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { ...actual, RateLimiter };
}
