import {
  formatQueueWait,
  showsQueueState,
} from "@stremlist/shared/provider-queue";
import { PROVIDERS } from "@stremlist/shared/providers";
import type { ProviderId } from "@stremlist/shared/providers";

/** A read that waits in a Provider's queue, as the page shows it. */
export interface QueueWait {
  provider: ProviderId;
  /** When the queue answered first, in ms since the epoch. */
  since: number;
  /** When the read should be done, in ms since the epoch. */
  readyAt: number;
}

/** Ask again at most this often, and at least this often. */
const MIN_RETRY_MS = 250;
const MAX_RETRY_MS = 15_000;

/** The wait of a queued answer received at `now`, after an earlier one. */
export function queueWait(
  answer: { provider: ProviderId; waitMs: number },
  now: number,
  previous: QueueWait | null,
): QueueWait {
  return {
    provider: answer.provider,
    since: previous?.provider === answer.provider ? previous.since : now,
    readyAt: now + answer.waitMs,
  };
}

/** When to ask again after a queued answer. */
export function retryDelay(retryMs: number): number {
  return Math.min(Math.max(retryMs, MIN_RETRY_MS), MAX_RETRY_MS);
}

/** The time left, never below 1 s while the queue state shows. */
function left(wait: QueueWait, now: number): string {
  return formatQueueWait(Math.max(wait.readyAt - now, 1000));
}

/**
 * The short queue state, for a button or a List row, or null when the wait
 * left is under 3 s: the read then looks like any other.
 */
export function queueLabel(wait: QueueWait | null, now: number): string | null {
  if (!wait || !showsQueueState(wait.readyAt - now)) return null;
  return `In the ${PROVIDERS[wait.provider].label} queue · about ${left(wait, now)}`;
}

/** The queue state of the Catalog preview. */
export function previewQueueMessage(wait: QueueWait, now: number): string {
  return `${PROVIDERS[wait.provider].label} is busy right now. Your list is in the queue, about ${left(wait, now)} left.`;
}

/**
 * How far the wait is, from 0 to 0.95: the bar fills with the time, and
 * never fills up before the read is done.
 */
export function queueProgress(wait: QueueWait, now: number): number {
  const total = wait.readyAt - wait.since;
  if (total <= 0) return 0.95;
  return Math.min(Math.max((now - wait.since) / total, 0), 0.95);
}
