/**
 * The slow sweep (ADR 0003): every Account once every 6 hours, in its own
 * minute of the cycle. It lists the library with `datastoreMeta`, reads the
 * items changed since the last sweep, and sends what the trigger missed.
 * It also takes the Watched baseline of an Account that has none yet.
 */
import type { ProviderId } from "@stremlist/shared/providers";
import { isProviderId } from "@stremlist/shared/providers";
import { mapWithConcurrency } from "../../lib/concurrency";
import { decryptSecret } from "../../lib/crypto";
import { supabase } from "../../lib/supabase";
import type { LibraryItem } from "../stremio";
import { StremioSessionError } from "../stremio";
import { recordItems, withItems } from "./detect";
import { readLibraryItems, readLibraryMeta, readStremioTrakt } from "./pace";
import { linkOf, readState, writeState } from "./state";

const IDS_PER_GET = 100;
const CONCURRENCY = 10;

export interface SweepStats {
  slots: number;
  accounts: number;
  baselines: number;
  detected: number;
  failed: number;
  /** Accounts left for their next turn, the run being out of time. */
  postponed: number;
}

async function readItems(
  authKey: string,
  ids: string[],
): Promise<LibraryItem[]> {
  const items: LibraryItem[] = [];
  for (let i = 0; i < ids.length; i += IDS_PER_GET) {
    items.push(
      ...(await readLibraryItems(authKey, ids.slice(i, i + IDS_PER_GET))),
    );
  }
  return items;
}

/**
 * Saves what the library shows as watched now, without sending it, and
 * whether Stremio's own Trakt is connected. The Account is tracked from
 * then on.
 */
export async function takeBaseline(
  accountId: string,
  sealedKey: string,
): Promise<void> {
  const authKey = decryptSecret(sealedKey);
  const meta = await readLibraryMeta(authKey);
  const items = await readItems(
    authKey,
    meta.map(([id]) => id),
  );
  const newest = Math.max(0, ...meta.map(([, mtime]) => mtime));
  // A baseline read with an older link's key must not replace the current
  // one: the member linked another Stremio account meanwhile. The state is
  // read before the key check and written only over that version, so a
  // newer baseline saved in between is never replaced.
  const before = await readState(accountId);
  const { data: link, error: linkError } = await supabase
    .from("stremio_connections")
    .select("auth_key")
    .eq("account_id", accountId)
    .maybeSingle();
  if (linkError) throw linkError;
  if (link?.auth_key !== sealedKey) return;
  const empty = {
    link: linkOf(sealedKey),
    checkedAt: 0,
    savedAt: Date.now(),
    movies: [],
    series: {},
  };
  const saved = await writeState(
    accountId,
    withItems(empty, items, newest) || empty,
    before.etag,
  );
  // Another baseline landed first: it sets the tracking row.
  if (!saved) return;
  const stremioTrakt = await readStremioTrakt(authKey);
  const { error } = await supabase
    .from("watch_tracking")
    .update({
      baseline_at: new Date().toISOString(),
      stremio_trakt: stremioTrakt,
    })
    .eq("account_id", accountId);
  if (error) throw error;
}

/**
 * The Destinations that get a title now, after a fresh look at whether
 * Stremio's own Trakt is connected: the flag is otherwise read only by the
 * sweep, so a member who connected it hours ago would get two Trakt plays.
 */
export async function destinationsNow(
  accountId: string,
  authKey: string,
  destinations: ProviderId[],
): Promise<ProviderId[]> {
  if (!destinations.includes("trakt")) return destinations;
  if (!(await readStremioTrakt(authKey))) return destinations;
  const { error } = await supabase
    .from("watch_tracking")
    .update({ stremio_trakt: true })
    .eq("account_id", accountId);
  if (error) throw error;
  return destinations.filter((provider) => provider !== "trakt");
}

async function sweepAccount(
  account: {
    account_id: string;
    auth_key: string;
    baseline_at: string | null;
    stremio_trakt: boolean;
    destinations: ProviderId[];
  },
  stats: SweepStats,
): Promise<void> {
  const authKey = decryptSecret(account.auth_key);
  const version = account.baseline_at
    ? await readState(account.account_id)
    : null;
  // No state, or one from another Stremio link: read the baseline again.
  if (version?.state?.link !== linkOf(account.auth_key)) {
    await takeBaseline(account.account_id, account.auth_key);
    stats.baselines += 1;
    return;
  }
  const { state: previous } = version;
  const [meta, stremioTrakt] = await Promise.all([
    readLibraryMeta(authKey),
    readStremioTrakt(authKey),
  ]);
  if (stremioTrakt !== account.stremio_trakt) {
    const { error } = await supabase
      .from("watch_tracking")
      .update({ stremio_trakt: stremioTrakt })
      .eq("account_id", account.account_id);
    if (error) throw error;
  }
  // Stremio's Trakt connected since the last sweep: Trakt gets nothing more.
  const destinations = stremioTrakt
    ? account.destinations.filter((provider) => provider !== "trakt")
    : account.destinations;
  const changed = meta.filter(([, mtime]) => mtime > previous.checkedAt);
  if (changed.length === 0) return;
  const items = await readItems(
    authKey,
    changed.map(([id]) => id),
  );
  const titles = await recordItems(account.account_id, destinations, items, {
    link: linkOf(account.auth_key),
    version,
    checkedAt: Math.max(...changed.map(([, mtime]) => mtime)),
  });
  stats.detected += titles.length;
}

/**
 * Sweeps the Accounts of the minutes due now, and catches up missed ones,
 * until `deadline`: an Account not swept by then waits for its next turn.
 */
export async function processSweep(deadline: number): Promise<SweepStats> {
  const stats: SweepStats = {
    slots: 0,
    accounts: 0,
    baselines: 0,
    detected: 0,
    failed: 0,
    postponed: 0,
  };
  const { data: slots, error } = await supabase.rpc("claim_sweep_slots", {
    p_now: new Date().toISOString(),
  });
  if (error) throw error;
  stats.slots = slots.length;
  if (slots.length === 0) return stats;
  const { data, error: accountsError } = await supabase.rpc(
    "watch_sweep_accounts",
    { p_slots: slots.map(({ slot }) => slot) },
  );
  if (accountsError) throw accountsError;
  stats.accounts = data.length;
  await mapWithConcurrency(data, CONCURRENCY, async (row) => {
    if (Date.now() >= deadline) {
      stats.postponed += 1;
      return;
    }
    try {
      await sweepAccount(
        {
          account_id: row.account_id,
          auth_key: row.auth_key,
          baseline_at: row.baseline_at as string | null,
          stremio_trakt: row.stremio_trakt,
          destinations: ((row.destinations as string[] | null) ?? []).filter(
            isProviderId,
          ),
        },
        stats,
      );
    } catch (error) {
      stats.failed += 1;
      // A signed-out key stays until the member links Stremio again; the
      // configure page shows it when an update fails.
      if (!(error instanceof StremioSessionError)) {
        console.error(
          `Watch tracking sweep of ${row.account_id} failed:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  });
  return stats;
}
