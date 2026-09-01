import type { ConfigWatchlist } from "@stremlist/shared";
import { randomUUID } from "node:crypto";
import { supabase } from "../lib/supabase";
import { getUserWatchlists } from "./user";
import { getWatchlistByConfig } from "./watchlist";

const PREWARM_CONCURRENCY = 2;
const PREWARM_LEASE_SECONDS =
  Number.isFinite(Number(process.env.PREWARM_LEASE_SECONDS)) &&
  Number(process.env.PREWARM_LEASE_SECONDS) > 0
    ? Number(process.env.PREWARM_LEASE_SECONDS)
    : 600;

async function requestPrewarm(
  ownerUserId: string,
  leaseToken: string,
): Promise<number | null> {
  const { data, error } = await supabase.rpc("request_watchlist_prewarm", {
    p_owner_user_id: ownerUserId,
    p_lease_seconds: PREWARM_LEASE_SECONDS,
    p_lease_token: leaseToken,
  });
  if (error) {
    console.error(`Failed to request prewarm for ${ownerUserId}:`, error);
    return null;
  }
  return data;
}

async function finishPrewarm(
  ownerUserId: string,
  leaseToken: string,
  completedGeneration: number,
): Promise<number | null> {
  const { data, error } = await supabase.rpc("finish_watchlist_prewarm", {
    p_owner_user_id: ownerUserId,
    p_lease_seconds: PREWARM_LEASE_SECONDS,
    p_lease_token: leaseToken,
    p_completed_generation: completedGeneration,
  });
  if (error) {
    console.error(`Failed to finish prewarm for ${ownerUserId}:`, error);
    return null;
  }
  return data;
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

export async function prewarmWatchlists(
  ownerUserId: string,
  watchlists: ConfigWatchlist[],
): Promise<void> {
  const leaseToken = randomUUID();
  let generation = await requestPrewarm(ownerUserId, leaseToken);
  if (generation === null) return;

  for (;;) {
    await runPrewarmBatch(ownerUserId, watchlists);
    const nextGeneration = await finishPrewarm(
      ownerUserId,
      leaseToken,
      generation,
    );
    if (nextGeneration === null) return;

    generation = nextGeneration;
    watchlists = await getUserWatchlists(ownerUserId);
  }
}
