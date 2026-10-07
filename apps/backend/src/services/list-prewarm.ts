import { parseSortOption } from "@stremlist/shared/constants";
import type { ProviderId } from "@stremlist/shared/providers";
import type { ConfigList } from "@stremlist/shared/stremio.types";
import { randomUUID } from "node:crypto";
import { supabase } from "../lib/supabase";
import { getAccountLists } from "./accounts";
import { getListCatalog } from "./lists";

const PREWARM_CONCURRENCY = 2;
const PREWARM_LEASE_SECONDS =
  Number.isFinite(Number(process.env.PREWARM_LEASE_SECONDS)) &&
  Number(process.env.PREWARM_LEASE_SECONDS) > 0
    ? Number(process.env.PREWARM_LEASE_SECONDS)
    : 600;

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
): Promise<void> {
  const startedAt = performance.now();
  let nextIndex = 0;
  let prewarmed = 0;

  async function worker(): Promise<void> {
    while (nextIndex < lists.length) {
      const list = lists[nextIndex];
      nextIndex += 1;

      try {
        await getListCatalog({
          accountId,
          listId: list.id,
          provider: list.provider,
          sourceRef: list.sourceRef,
          sort: parseSortOption(list.sortOption),
          // Prewarming only needs the canonical cache. Poster customization is
          // applied later when Stremio requests the catalog.
          rpdbApiKey: null,
          allowConnection,
          skipAccountTimestamp: true,
          // Runs in the background after a save, so it can resolve more of a
          // big cold list. Kept short because a catalog request for the same
          // List joins this read instead of starting its own.
          resolveBudgetMs: 25_000,
        });
        prewarmed += 1;
      } catch (error) {
        console.error(`Failed to prewarm list ${list.id}:`, error);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PREWARM_CONCURRENCY, lists.length) }, () =>
      worker(),
    ),
  );

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
): Promise<void> {
  const leaseToken = randomUUID();
  let generation = await requestPrewarm(accountId, leaseToken);
  if (generation === null) return;

  for (;;) {
    await runPrewarmBatch(accountId, lists, allowConnection);
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

/**
 * After a new authorization: read the Account's Lists on that Provider again,
 * so their Catalogs and sync status follow the new Connection at once instead
 * of at the next stale read.
 */
export async function refreshProviderLists(
  accountId: string,
  provider: ProviderId,
): Promise<void> {
  const lists = (await getAccountLists(accountId)).filter(
    (list) => list.provider === provider,
  );
  for (const list of lists) {
    try {
      await getListCatalog({
        accountId,
        listId: list.id,
        provider: list.provider,
        sourceRef: list.sourceRef,
        sort: parseSortOption(list.sortOption),
        rpdbApiKey: null,
        allowConnection: true,
        forceFresh: true,
        skipAccountTimestamp: true,
        noCacheFallback: true,
        freshRead: true,
        resolveBudgetMs: 25_000,
      });
    } catch (error) {
      console.error(
        `Failed to refresh list ${list.id} after connecting ${provider}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}
