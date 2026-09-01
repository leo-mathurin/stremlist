import type { ConfigWatchlist } from "@stremlist/shared";
import { getWatchlistByConfig } from "./watchlist";

const PREWARM_CONCURRENCY = 2;

async function runPrewarmBatch(
  ownerUserId: string,
  watchlists: ConfigWatchlist[],
): Promise<void> {
  const startedAt = performance.now();
  let nextIndex = 0;
  let prewarmed = 0;

  async function worker(): Promise<void> {
    while (nextIndex < watchlists.length) {
      const index = nextIndex;
      nextIndex += 1;
      const watchlist = watchlists[index];

      try {
        await getWatchlistByConfig({
          ownerUserId,
          watchlistId: watchlist.id,
          imdbUserId: watchlist.imdbUserId,
          sortOption: watchlist.sortOption,
          // Prewarming only needs the canonical cache. Poster customization is
          // applied later when Stremio requests the catalog.
          rpdbApiKey: null,
          skipUserTimestamp: true,
        });
        prewarmed += 1;
      } catch (error) {
        console.error(`Failed to prewarm watchlist ${watchlist.id}:`, error);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(PREWARM_CONCURRENCY, watchlists.length) },
    () => worker(),
  );
  await Promise.all(workers);

  console.log(
    `Prewarmed ${prewarmed}/${watchlists.length} watchlists in ${Math.round(performance.now() - startedAt)}ms`,
  );
}

interface PrewarmState {
  activeSignature: string;
  pendingWatchlists: ConfigWatchlist[] | null;
}

interface InFlightPrewarm {
  state: PrewarmState;
  promise: Promise<void>;
}

const inFlightBatches = new Map<string, InFlightPrewarm>();

function watchlistSignature(watchlists: ConfigWatchlist[]): string {
  return watchlists
    .map((watchlist) => `${watchlist.id}:${watchlist.imdbUserId}`)
    .join("|");
}

async function runQueuedBatches(
  ownerUserId: string,
  firstWatchlists: ConfigWatchlist[],
  state: PrewarmState,
): Promise<void> {
  let watchlists: ConfigWatchlist[] | null = firstWatchlists;
  while (watchlists) {
    state.activeSignature = watchlistSignature(watchlists);
    state.pendingWatchlists = null;
    await runPrewarmBatch(ownerUserId, watchlists);
    watchlists = state.pendingWatchlists;
  }
}

export function prewarmWatchlists(
  ownerUserId: string,
  watchlists: ConfigWatchlist[],
): Promise<void> {
  const signature = watchlistSignature(watchlists);
  const existing = inFlightBatches.get(ownerUserId);
  if (existing) {
    existing.state.pendingWatchlists =
      signature === existing.state.activeSignature ? null : watchlists;
    return existing.promise;
  }

  const state: PrewarmState = {
    activeSignature: signature,
    pendingWatchlists: null,
  };
  const batch = runQueuedBatches(ownerUserId, watchlists, state);
  const inFlight = { state, promise: batch };
  inFlightBatches.set(ownerUserId, inFlight);
  void batch.then(
    () => {
      if (inFlightBatches.get(ownerUserId) === inFlight) {
        inFlightBatches.delete(ownerUserId);
      }
    },
    () => {
      if (inFlightBatches.get(ownerUserId) === inFlight) {
        inFlightBatches.delete(ownerUserId);
      }
    },
  );
  return batch;
}
