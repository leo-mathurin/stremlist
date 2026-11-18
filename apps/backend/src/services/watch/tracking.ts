import type { ProviderId } from "@stremlist/shared/providers";
import type {
  WatchDestinationError as DestinationErrorCode,
  WatchedTitleRef,
  WatchProviderId,
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
        .select("stremio_trakt")
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
    stremioLinked: link.data !== null,
    stremioTrakt,
    destinations: WATCH_PROVIDERS.filter(
      (provider) => connected.has(provider) && isProviderEnabled(provider),
    ).map((provider) => {
      const row = rows.get(provider);
      return {
        provider,
        enabled: row !== undefined,
        paused: row !== undefined && provider === "trakt" && stremioTrakt,
        lastTitle: lastTitleSchema.parse(row?.last_title ?? null),
        lastSuccessAt: row?.last_success_at ?? null,
        lastError: lastErrorSchema.parse(row?.last_error ?? null),
        lastErrorAt: row?.last_error_at ?? null,
        pending: (pending.data ?? []).filter((w) => w.provider === provider)
          .length,
      };
    }),
  };
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

/**
 * Makes `providers` the Account's Destinations. The first one reads the
 * Watched baseline: a failure there turns Watch tracking off again and
 * throws, so the member can try again.
 */
export async function setWatchDestinations(
  accountId: string,
  providers: ProviderId[],
) {
  forgetWatchContext(accountId);
  const wanted = [...new Set(providers)];
  if (wanted.length === 0) {
    await stopTracking(accountId);
    return;
  }
  const connected = new Set(
    (await listConnections(accountId)).map(({ provider }) => provider),
  );
  const destinations: WatchProviderId[] = [];
  for (const provider of wanted) {
    if (
      !isWatchProvider(provider) ||
      !connected.has(provider) ||
      !isProviderEnabled(provider)
    ) {
      throw new WatchDestinationError(provider);
    }
    destinations.push(provider);
  }
  const authKey = await stremioKey(accountId);

  const started = !(await isTrackedNow(accountId));
  if (started) {
    const { error } = await supabase
      .from("watch_tracking")
      .upsert(
        {
          account_id: accountId,
          sweep_slot: randomInt(360),
          baseline_at: null,
        },
        { onConflict: "account_id", ignoreDuplicates: true },
      );
    if (error) throw error;
  }
  const { error: addError } = await supabase.from("watch_destinations").upsert(
    destinations.map((provider) => ({ account_id: accountId, provider })),
    { onConflict: "account_id,provider", ignoreDuplicates: true },
  );
  if (addError) throw addError;
  const { error: removeError } = await supabase
    .from("watch_destinations")
    .delete()
    .eq("account_id", accountId)
    .not("provider", "in", `(${destinations.join(",")})`);
  if (removeError) throw removeError;

  if (!started && destinations.includes("trakt")) {
    const { error } = await supabase
      .from("watch_tracking")
      .update({ stremio_trakt: await readStremioTrakt(decryptSecret(authKey)) })
      .eq("account_id", accountId);
    if (error) throw error;
  }
  if (started) {
    try {
      await takeBaseline(accountId, authKey);
    } catch (error) {
      await stopTracking(accountId).catch((stopError: unknown) => {
        console.error("Failed to undo Watch tracking:", stopError);
      });
      throw error;
    }
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
