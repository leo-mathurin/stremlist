import { parseSortOption } from "@stremlist/shared/constants";
import { listSources } from "@stremlist/shared/list-merge";
import type { MetadataLanguage } from "@stremlist/shared/metadata-language";
import { isLocalizedLanguage } from "@stremlist/shared/metadata-language";
import type { ConfigList } from "@stremlist/shared/stremio.types";
import { randomUUID } from "node:crypto";
import { supabase } from "../lib/supabase";
import { findPosters } from "../titles/title-posters";
import { findTranslations } from "../titles/title-translations";
import { getAccountLists } from "./accounts";
import { getListCatalog } from "./lists";
import type { PosterSettings } from "./posters";
import { lookupSourceOf } from "./posters";

type PrewarmSettings = PosterSettings & {
  metadataLanguage?: MetadataLanguage;
};

const PREWARM_SOURCES = 10;
const PREWARM_QUEUE_MS = 200_000;
const PREWARM_POSTERS_PER_CATALOG = 100;
const leaseSeconds = Number(process.env.PREWARM_LEASE_SECONDS);
const PREWARM_LEASE_SECONDS =
  Number.isFinite(leaseSeconds) && leaseSeconds > 0 ? leaseSeconds : 600;

async function requestPrewarm(accountId: string, leaseToken: string) {
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
) {
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
  settings: PrewarmSettings | null,
) {
  const startedAt = performance.now();
  const queueDeadline = Date.now() + PREWARM_QUEUE_MS;
  let prewarmed = 0;
  let free = PREWARM_SOURCES;
  let waiting: (() => void)[] = [];

  const prewarmList = async (list: ConfigList) => {
    const sources = Math.min(listSources(list).length, PREWARM_SOURCES);
    while (free < sources) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    free -= sources;
    try {
      const { metas } = await getListCatalog(list, {
        accountId,
        sort: parseSortOption(list.sortOption),
        allowConnection,
        policy: "prewarm",
        queueDeadline,
      });
      prewarmed += 1;
      const source = settings && lookupSourceOf(settings);
      const language =
        settings?.metadataLanguage &&
        isLocalizedLanguage(settings.metadataLanguage)
          ? settings.metadataLanguage
          : null;
      if (source || language) {
        const types =
          list.displayMode === "split"
            ? (["movie", "series"] as const)
            : [list.displayMode];
        for (const type of types) {
          const slice = metas
            .filter((meta) => meta.type === type)
            .slice(0, PREWARM_POSTERS_PER_CATALOG);
          if (source) {
            await findPosters(source, slice, {
              budgetMs: Infinity,
              size: "stremio",
            });
          }
          if (language) {
            await findTranslations(language, slice, { budgetMs: Infinity });
          }
        }
      }
    } catch (error) {
      console.error(`Failed to prewarm list ${list.id}:`, error);
    } finally {
      free += sources;
      const woken = waiting;
      waiting = [];
      for (const wake of woken) wake();
    }
  };
  await Promise.all(lists.map(prewarmList));

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
  settings: PrewarmSettings | null = null,
) {
  const leaseToken = randomUUID();
  let generation = await requestPrewarm(accountId, leaseToken);
  if (generation === null) return;

  for (;;) {
    await runPrewarmBatch(accountId, lists, allowConnection, settings);
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
