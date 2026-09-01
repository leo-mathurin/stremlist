import type { ConfigWatchlist } from "@stremlist/shared";
import { randomUUID } from "node:crypto";
import { supabase } from "../lib/supabase";
import { getWatchlistByConfig } from "./watchlist";

const PREWARM_CONCURRENCY = 2;
const PREWARM_LEASE_SECONDS =
  Number.isFinite(Number(process.env.PREWARM_LEASE_SECONDS)) &&
  Number(process.env.PREWARM_LEASE_SECONDS) > 0
    ? Number(process.env.PREWARM_LEASE_SECONDS)
    : 600;

async function acquirePrewarmLease(
  ownerUserId: string,
  leaseToken: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc(
    "try_acquire_watchlist_prewarm_lease",
    {
      p_owner_user_id: ownerUserId,
      p_lease_seconds: PREWARM_LEASE_SECONDS,
      p_lease_token: leaseToken,
    },
  );
  if (error) {
    console.error(`Failed to acquire prewarm lease for ${ownerUserId}:`, error);
    return false;
  }
  return data;
}

async function releasePrewarmLease(
  ownerUserId: string,
  leaseToken: string,
): Promise<void> {
  const { error } = await supabase.rpc("release_watchlist_prewarm_lease", {
    p_owner_user_id: ownerUserId,
    p_lease_token: leaseToken,
  });
  if (error) {
    console.error(`Failed to release prewarm lease for ${ownerUserId}:`, error);
  }
}

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
  const leaseToken = randomUUID();
  if (!(await acquirePrewarmLease(ownerUserId, leaseToken))) return;

  try {
    let watchlists: ConfigWatchlist[] | null = firstWatchlists;
    while (watchlists) {
      state.activeSignature = watchlistSignature(watchlists);
      await runPrewarmBatch(ownerUserId, watchlists);
      watchlists = state.pendingWatchlists;
      state.pendingWatchlists = null;
    }
  } finally {
    await releasePrewarmLease(ownerUserId, leaseToken);
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
