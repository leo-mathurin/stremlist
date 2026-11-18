import { parseSortOption } from "@stremlist/shared/constants";
import type { ConfigList } from "@stremlist/shared/stremio.types";
import { randomUUID } from "node:crypto";
import { mapWithConcurrency } from "../lib/concurrency";
import { supabase } from "../lib/supabase";
import { findPosters } from "../titles/title-posters";
import { getAccountLists } from "./accounts";
import { getListCatalog } from "./lists";
import type { PosterSettings } from "./posters";
import { lookupSourceOf } from "./posters";

const PREWARM_CONCURRENCY = 2;
/**
 * How long the Lists of one prewarm may wait in Provider queues in total
 * (Letterboxd), within the 300 s that a function may run.
 */
const PREWARM_QUEUE_MS = 200_000;
/** TMDB posters looked up per Catalog: the first page that Stremio asks for. */
const PREWARM_POSTERS_PER_CATALOG = 100;
const leaseSeconds = Number(process.env.PREWARM_LEASE_SECONDS);
const PREWARM_LEASE_SECONDS =
  Number.isFinite(leaseSeconds) && leaseSeconds > 0 ? leaseSeconds : 600;

async function requestPrewarm(
  accountId: string,
  leaseToken: string,
): Promise<number | null> {
  const { data, error } = await supabase.rpc("request_list_prewarm", {
    p_account_id: accountId,
    p_lease_seconds: PREWARM_LEASE_SECONDS,
    p_lease_token: leaseToken,
  });
  if (error) {
    console.error(`Failed to request prewarm for ${accountId}:`, error);
    return null;
  }
  return data;
}

async function finishPrewarm(
  accountId: string,
  leaseToken: string,
  completedGeneration: number,
): Promise<number | null> {
  const { data, error } = await supabase.rpc("finish_list_prewarm", {
    p_account_id: accountId,
    p_lease_seconds: PREWARM_LEASE_SECONDS,
    p_lease_token: leaseToken,
    p_completed_generation: completedGeneration,
  });
  if (error) {
    console.error(`Failed to finish prewarm for ${accountId}:`, error);
    return null;
  }
  return data;
}

async function runPrewarmBatch(
  accountId: string,
  lists: ConfigList[],
  allowConnection: boolean,
  posters: PosterSettings | null,
): Promise<void> {
  const startedAt = performance.now();
  const queueDeadline = Date.now() + PREWARM_QUEUE_MS;
  let prewarmed = 0;

  await mapWithConcurrency(lists, PREWARM_CONCURRENCY, async (list) => {
    try {
      const { metas } = await getListCatalog(list, {
        accountId,
        sort: parseSortOption(list.sortOption),
        allowConnection,
        policy: "prewarm",
        queueDeadline,
      });
      prewarmed += 1;
      // Posters are applied when Stremio requests the Catalog. Looking up
      // the TMDB or TheTVDB ones of its first page now lets that request
      // find them.
      const source = posters && lookupSourceOf(posters);
      if (source) {
        const types =
          list.displayMode === "split"
            ? (["movie", "series"] as const)
            : [list.displayMode];
        // One call per Catalog: each call looks up at most one page.
        for (const type of types) {
          await findPosters(
            source,
            metas
              .filter((meta) => meta.type === type)
              .slice(0, PREWARM_POSTERS_PER_CATALOG),
            { budgetMs: Infinity, size: "stremio" },
          );
        }
      }
    } catch (error) {
      console.error(`Failed to prewarm list ${list.id}:`, error);
    }
  });

  console.log(
    `Prewarmed ${prewarmed}/${lists.length} lists in ${Math.round(performance.now() - startedAt)}ms`,
  );
}

/**
 * Warm the Catalogs of an Account after a save, so Stremio's first request
 * finds them cached. Saves that arrive during a prewarm are queued through a
 * lease generation counter instead of starting a second prewarm.
 */
export async function prewarmLists(
  accountId: string,
  lists: ConfigList[],
  allowConnection: boolean,
  /** The poster settings of the save; null looks up no TMDB poster. */
  posters: PosterSettings | null = null,
): Promise<void> {
  const leaseToken = randomUUID();
  let generation = await requestPrewarm(accountId, leaseToken);
  if (generation === null) return;

  for (;;) {
    await runPrewarmBatch(accountId, lists, allowConnection, posters);
    const nextGeneration = await finishPrewarm(
      accountId,
      leaseToken,
      generation,
    );
    if (nextGeneration === null) return;
    generation = nextGeneration;
    lists = await getAccountLists(accountId);
  }
}
