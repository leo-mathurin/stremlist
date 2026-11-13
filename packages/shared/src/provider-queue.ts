import type { ProviderId } from "./providers";
import { PROVIDERS } from "./providers";

/**
 * The wait in a Provider's request queue (Letterboxd) that the configure
 * page shows: a shorter wait looks like any other read.
 */
export const QUEUE_STATE_MIN_MS = 3_000;

/** Whether a wait is long enough to show the queue state. */
export function showsQueueState(waitMs: number): boolean {
  return waitMs >= QUEUE_STATE_MIN_MS;
}

/** An estimated wait, in seconds under a minute, then in minutes. */
export function formatQueueWait(waitMs: number): string {
  const seconds = Math.max(1, Math.round(waitMs / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/**
 * The answer of a read that waits in the Provider's queue. Ask again after
 * `retryMs` with `ticket`, to keep the place in the queue.
 */
export interface QueuedAnswer {
  ok: false;
  reason: "queued";
  /** The Provider whose queue the read waits in. */
  provider: ProviderId;
  /** Estimated time until the read is done, in ms. */
  waitMs: number;
  retryMs: number;
  ticket: string | null;
}

export interface QueuedCatalogCopy {
  title: string;
  description: string;
}

/**
 * The Stremio card of a List that is not read yet because the Provider is
 * busy: the read goes on in the background.
 */
export function queuedCatalogCopy(provider: ProviderId): QueuedCatalogCopy {
  const label = PROVIDERS[provider].label;
  return {
    title: `Your ${label} list is on its way`,
    description: `${label} is busy right now. Stremlist is reading your list and it will show here in a few minutes.`,
  };
}
