import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Why a Provider is read, for Providers that share a request budget
 * (Letterboxd). An interactive read has someone waiting for it: a new List,
 * a Catalog without a cache, a Refresh. A background read refreshes a
 * Catalog that is already cached and never queues ahead of someone waiting.
 */
export type ReadPriority = "interactive" | "background";

const storage = new AsyncLocalStorage<ReadPriority>();

/** Run a read, including its ID resolution, at this priority. */
export function withReadPriority<T>(
  priority: ReadPriority,
  read: () => Promise<T>,
): Promise<T> {
  return storage.run(priority, read);
}

/** Reads started outside withReadPriority are interactive. */
export function currentReadPriority(): ReadPriority {
  return storage.getStore() ?? "interactive";
}
