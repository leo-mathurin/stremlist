import { isProviderId } from "@stremlist/shared/providers";
import { decryptSecret } from "../../lib/crypto";
import { LruCache } from "../../lib/lru";
import { supabase } from "../../lib/supabase";
import type { LibraryItem } from "../stremio";
import { recordItems } from "./detect";
import { isEpisodeWatched, movieWatched } from "./library";
import { readLibraryItems } from "./pace";
import { newCycle, planAfterRead } from "./schedule";
import { linkOf } from "./state";
import { destinationsNow } from "./sweep";

interface WatchContext {
  authKey: string;
  hasBaseline: boolean;
}

const contexts = new LruCache<string, WatchContext | null>({
  maxEntries: 5000,
  ttlMs: 60_000,
});

async function watchContext(accountId: string) {
  const cached = contexts.get(accountId);
  if (cached !== undefined) return cached;
  const { data, error } = await supabase.rpc("watch_context", {
    p_account_id: accountId,
  });
  if (error) throw error;
  const row = data.at(0);
  const context = row
    ? {
        authKey: row.auth_key,
        hasBaseline: (row.baseline_at as string | null) !== null,
      }
    : null;
  contexts.set(accountId, context);
  return context;
}

/** Forget the cached context after a change of the Account's tracking. */
export function forgetWatchContext(accountId: string) {
  contexts.delete(accountId);
}

function hasWatched(item: LibraryItem) {
  return item.type === "movie"
    ? movieWatched(item)
    : Boolean(item.state?.watched);
}

async function sendNewTitles(
  accountId: string,
  context: WatchContext,
  item: LibraryItem,
) {
  await recordItems(
    accountId,
    async () => {
      const { data, error } = await supabase.rpc("watch_destination_list", {
        p_account_id: accountId,
      });
      if (error) throw error;
      return destinationsNow(
        accountId,
        decryptSecret(context.authKey),
        data.filter(isProviderId),
      );
    },
    [item],
    { link: linkOf(context.authKey) },
  );
}

/**
 * A /stream request of a tracked Account: read the item, send what it
 * shows as newly watched, then start its cycle. The cycle of a series is
 * shared by its episodes and starts from what is watched now, so an
 * episode that turned watched since the last read must be sent first: the
 * app asks for the streams of the next episode as the previous one ends.
 * A title that Stremio already shows as watched has no cycle: a replay is
 * never sent.
 */
export async function onStreamRequest(
  accountId: string,
  type: "movie" | "series",
  videoId: string,
) {
  const context = await watchContext(accountId);
  if (!context) return;
  const itemId = videoId.split(":")[0];
  const [item] = await readLibraryItems(decryptSecret(context.authKey), [
    itemId,
  ]);
  const watched =
    type === "movie"
      ? movieWatched(item)
      : await isEpisodeWatched(item, videoId);
  if (context.hasBaseline && item && hasWatched(item)) {
    try {
      await sendNewTitles(accountId, context, item);
    } catch (error) {
      console.error(
        `Watch tracking send on /stream failed for ${accountId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  if (watched) return;
  const now = Date.now();
  const row = newCycle(type, videoId, item, now);
  const plan = planAfterRead(row, item, false, now);
  const iso = (value: number | null) =>
    value === null ? undefined : new Date(value).toISOString();
  const { error } = await supabase.rpc("watch_restart", {
    p_account_id: accountId,
    p_item_id: itemId,
    p_item_type: type,
    p_video_id: videoId,
    p_due_at: new Date(plan.next ?? now + 120_000).toISOString(),
    p_phase: plan.row.phase,
    p_start_state: { ...row.startState },
    p_last_time_watched: plan.row.lastTimeWatched ?? undefined,
    p_expected_flip_at: iso(plan.row.expectedFlipAt),
    p_expected_end_at: iso(plan.row.expectedEndAt),
  });
  if (error) throw error;
}

/** A `pause` or `stop` of Stremio Web: read the item at the next run. */
export async function onPlayerEvent(
  accountId: string,
  videoId: string,
  type: "movie" | "series",
) {
  const { error } = await supabase.rpc("watch_recover_cycle", {
    p_account_id: accountId,
    p_item_id: videoId.split(":")[0],
    p_type: type,
    p_video_id: videoId,
  });
  if (error) throw error;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const EVENT_SETTLE_MS = 3000;

/**
 * A manual mark in Stremio Web: read the item a few seconds later and send
 * what is new against the Account's watch state.
 */
export async function onLibraryWatchedEvent(accountId: string, itemId: string) {
  const context = await watchContext(accountId);
  if (!context?.hasBaseline) return;
  await sleep(EVENT_SETTLE_MS);
  const item = (
    await readLibraryItems(decryptSecret(context.authKey), [itemId])
  ).at(0);
  if (!item) return;
  await sendNewTitles(accountId, context, item);
}
