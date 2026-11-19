import type { ProviderId } from "@stremlist/shared/providers";
import type {
  WatchDestinationError as DestinationErrorCode,
  WatchedTitleRef,
  WatchTrackingStatus,
} from "@stremlist/shared/watch-tracking";
import {
  isWatchProvider,
  WATCH_PROVIDERS,
} from "@stremlist/shared/watch-tracking";
import { z } from "zod";
import { randomInt } from "node:crypto";
import { decryptSecret } from "../../lib/crypto";
import { supabase } from "../../lib/supabase";
import { isProviderEnabled } from "../../providers/registry";
import { listConnections } from "../connections";
import { readStremioTrakt } from "./pace";
import { deleteState } from "./state";
import { takeBaseline } from "./sweep";
import { forgetWatchContext } from "./trigger";

const lastTitleSchema = z
  .object({
    imdbId: z.string(),
    type: z.enum(["movie", "series"]),
    season: z.number().optional(),
    episode: z.number().optional(),
  })
  .nullable()
  .catch(null) satisfies z.ZodType<WatchedTitleRef | null>;

const lastErrorSchema = z
  .enum(["not_found", "needs_renewal", "gave_up"])
  .nullable()
  .catch(null) satisfies z.ZodType<DestinationErrorCode | null>;

/** Watch tracking needs a Stremio link. */
export class WatchNeedsStremioError extends Error {
  constructor() {
    super("Watch tracking needs a linked Stremio account.");
    this.name = "WatchNeedsStremioError";
  }
}

/** A Destination must be a connected Provider that can receive titles. */
export class WatchDestinationError extends Error {
  constructor(provider: string) {
    super(`${provider} cannot be a Destination of this Account.`);
    this.name = "WatchDestinationError";
  }
}

/** Whether the Account is tracked, read from the database (no cache). */
export async function isTrackedNow(accountId: string) {
  const { data, error } = await supabase
    .from("watch_tracking")
    .select("account_id")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

export async function getWatchTracking(accountId: string) {
  const [connections, link, tracking, destinations, pending] =
    await Promise.all([
      listConnections(accountId),
      supabase
        .from("stremio_connections")
        .select("account_id")
        .eq("account_id", accountId)
        .maybeSingle(),
      supabase
        .from("watch_tracking")
        .select("stremio_trakt, consented_at")
        .eq("account_id", accountId)
        .maybeSingle(),
      supabase
        .from("watch_destinations")
        .select("*")
        .eq("account_id", accountId),
      supabase
        .from("watch_writes")
        .select("provider")
        .eq("account_id", accountId),
    ]);
  for (const result of [link, tracking, destinations, pending]) {
    if (result.error) throw result.error;
  }
  const stremioTrakt = tracking.data?.stremio_trakt ?? false;
  const rows = new Map(
    (destinations.data ?? []).map((row) => [row.provider, row]),
  );
  const connected = new Set(connections.map(({ provider }) => provider));
  return {
    consented: tracking.data?.consented_at != null,
    stremioLinked: link.data !== null,
    stremioTrakt,
    destinations: WATCH_PROVIDERS.filter(
      (provider) => connected.has(provider) && isProviderEnabled(provider),
    ).map((provider) => {
      const row = rows.get(provider);
      return {
        provider,
        enabled: row?.watched_enabled ?? false,
        watchlistEnabled: row?.watchlist_enabled ?? false,
        lastKind: row?.last_kind === "watchlist" ? "watchlist" : "watched",
        paused: !!row?.watched_enabled && provider === "trakt" && stremioTrakt,
        lastTitle: lastTitleSchema.parse(row?.last_title ?? null),
        lastSuccessAt: row?.last_success_at ?? null,
        lastError: lastErrorSchema.parse(row?.last_error ?? null),
        lastErrorAt: row?.last_error_at ?? null,
        pending: (pending.data ?? []).filter((w) => w.provider === provider)
          .length,
      };
    }),
  } satisfies WatchTrackingStatus;
}

async function stremioKey(accountId: string) {
  const { data, error } = await supabase
    .from("stremio_connections")
    .select("auth_key")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new WatchNeedsStremioError();
  return data.auth_key;
}

async function stopTracking(accountId: string) {
  const { error } = await supabase
    .from("watch_tracking")
    .delete()
    .eq("account_id", accountId);
  if (error) throw error;
  await deleteState(accountId);
}

/** First-time activity sharing needs an affirmative permission. */
export class WatchConsentError extends Error {}

/** Apply both choices after the initial watched baseline is ready. */
export async function setWatchDestinations(
  accountId: string,
  providers: ProviderId[],
  activity: { watchlist?: ProviderId[]; consent?: boolean } = {},
) {
  const current = await getWatchTracking(accountId);
  const watched = [...new Set(providers)];
  const watchlist = [
    ...new Set(
      activity.watchlist ??
        current.destinations
          .filter((d) => d.watchlistEnabled)
          .map((d) => d.provider),
    ),
  ];
  const wanted = [...new Set([...watched, ...watchlist])];
  const adding =
    watched.some(
      (p) => !current.destinations.some((d) => d.provider === p && d.enabled),
    ) ||
    watchlist.some(
      (p) =>
        !current.destinations.some(
          (d) => d.provider === p && d.watchlistEnabled,
        ),
    );
  if (adding && !current.consented && !activity.consent)
    throw new WatchConsentError("consent-required");
  for (const provider of wanted) {
    if (
      !isWatchProvider(provider) ||
      !current.destinations.some((d) => d.provider === provider)
    )
      throw new WatchDestinationError(provider);
  }
  try {
    if (wanted.length === 0) {
      await stopTracking(accountId);
      return;
    }
    const authKey = await stremioKey(accountId);
    const { error: startError } = await supabase
      .from("watch_tracking")
      .upsert(
        { account_id: accountId, sweep_slot: randomInt(360) },
        { onConflict: "account_id", ignoreDuplicates: true },
      );
    if (startError) throw startError;
    const { data: tracking, error: trackingError } = await supabase
      .from("watch_tracking")
      .select("baseline_at")
      .eq("account_id", accountId)
      .single();
    if (trackingError) throw trackingError;
    if (
      !tracking.baseline_at ||
      (watched.length > 0 && !current.destinations.some((d) => d.enabled))
    ) {
      await takeBaseline(accountId, authKey);
      const { data: baseline, error: baselineError } = await supabase
        .from("watch_tracking")
        .select("baseline_at")
        .eq("account_id", accountId)
        .maybeSingle();
      if (baselineError) throw baselineError;

      if (
        !baseline?.baseline_at ||
        baseline.baseline_at === tracking.baseline_at
      )
        throw new Error("Stremio library changed during setup. Try again.");
    }
    if (watched.includes("trakt")) {
      const { error } = await supabase
        .from("watch_tracking")
        .update({
          stremio_trakt: await readStremioTrakt(decryptSecret(authKey)),
        })
        .eq("account_id", accountId);
      if (error) throw error;
    }
    const { error } = await supabase.rpc("configure_watch_activity", {
      p_account_id: accountId,
      p_watched: watched,
      p_watchlist: watchlist,
      p_consent: activity.consent === true,
    });
    if (error?.message.includes("consent-required"))
      throw new WatchConsentError("consent-required");
    if (error) throw error;
  } catch (error) {
    const { error: cleanupError } = await supabase.rpc(
      "discard_empty_watch_activity",
      { p_account_id: accountId },
    );
    if (cleanupError)
      console.error("Failed to discard empty activity setup:", cleanupError);
    throw error;
  } finally {
    forgetWatchContext(accountId);
  }
}

/**
 * Before a new Stremio link is saved: what the other account watched is no
 * reference, so nothing is sent until the Watched baseline is read again,
 * and the running cycles end. Returns whether the Account is tracked.
 */
export async function invalidateWatchBaseline(accountId: string) {
  forgetWatchContext(accountId);
  const { data, error } = await supabase
    .from("watch_tracking")
    .update({ baseline_at: null })
    .eq("account_id", accountId)
    .select("account_id");
  if (error) throw error;
  if (data.length === 0) return false;
  const { error: readsError } = await supabase
    .from("watch_reads")
    .delete()
    .eq("account_id", accountId);
  if (readsError) throw readsError;
  return true;
}

/** After a new Stremio link is saved: read its Watched baseline. */
export async function retakeWatchBaseline(accountId: string) {
  await takeBaseline(accountId, await stremioKey(accountId));
}
