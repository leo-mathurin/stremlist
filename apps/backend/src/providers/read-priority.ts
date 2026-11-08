import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Why a Provider is read, for Providers that share a request budget
 * (Letterboxd). An interactive read has someone waiting for it: a new List,
 * a Catalog without a cache, a Refresh. A background read refreshes a
 * Catalog that is already cached and never queues ahead of someone waiting.
 */
export type ReadPriority = "interactive" | "background";

/** How long an interactive read may wait in a Provider's request queue. */
export interface QueuePolicy {
  /** Longest total wait for send slots, from the start of the read. */
  maxWaitMs: number;
  /**
   * Stop at once when the next send slot is this far away, so the caller
   * can show the queue state and ask again with the ticket.
   */
  answerAtMs?: number;
  /** When a later page would wait too long, keep the pages read so far. */
  partial?: boolean;
  /** The read's place in the queue, from an earlier answer. */
  ticket?: string | null;
  /** Called with the estimated wait each time the read waits its turn. */
  onQueued?: (waitMs: number) => void;
}

/** The queue state of one read, shared by everything it sends. */
export interface ReadQueue {
  readonly deadline: number;
  readonly answerAtMs: number | null;
  readonly partial: boolean;
  /** Updated by each answer of the queue. */
  ticket: string | null;
  readonly onQueued?: (waitMs: number) => void;
}

/** A read without a queue policy waits at most this long for each request. */
const DEFAULT_MAX_WAIT_MS = 10_000;

interface ReadContext {
  priority: ReadPriority;
  queue: ReadQueue | null;
}

const storage = new AsyncLocalStorage<ReadContext>();

/** The queue state of a new read. */
export function readQueue(policy: QueuePolicy): ReadQueue {
  return {
    deadline: Date.now() + policy.maxWaitMs,
    answerAtMs: policy.answerAtMs ?? null,
    partial: policy.partial ?? false,
    ticket: policy.ticket ?? null,
    onQueued: policy.onQueued,
  };
}

/**
 * Run a read, including its ID resolution, at this priority. With a queue,
 * every request of the read shares its deadline and its place in the queue.
 */
export function withReadPriority<T>(
  priority: ReadPriority,
  read: () => Promise<T>,
  queue: ReadQueue | null = null,
): Promise<T> {
  return storage.run({ priority, queue }, read);
}

/** Reads started outside withReadPriority are interactive. */
export function currentReadPriority(): ReadPriority {
  return storage.getStore()?.priority ?? "interactive";
}

/**
 * The queue state of the current read. Outside a read with a queue, each
 * request waits at most 10 s on its own.
 */
export function currentReadQueue(): ReadQueue {
  return (
    storage.getStore()?.queue ?? readQueue({ maxWaitMs: DEFAULT_MAX_WAIT_MS })
  );
}
