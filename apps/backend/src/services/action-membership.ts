import type { ProviderId } from "@stremlist/shared/providers";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { scheduleBackgroundTask } from "../lib/background";
import { LruCache } from "../lib/lru";
import {
  connectionPrefix,
  isPreconditionFailed,
  readJson,
  readJsonVersion,
  writeJson,
} from "../lib/r2-json";
import { getProvider } from "../providers/registry";
import type {
  ActionIntent,
  ActionTarget,
  ConnectionAccess,
  Membership,
} from "../providers/types";
import { getConnectionAccess } from "./connections";

/** Membership older than this is refreshed in the background. */
export const MEMBERSHIP_FRESH_MS = 15 * 60_000;
/**
 * How long this instance trusts its copy of a membership (or of its absence)
 * before it reads R2 again and sees what other instances wrote.
 */
const MEMORY_MEMBERSHIP_TTL_MS = 60_000;
/**
 * A large membership (10,000 Titles and 20,000 episodes) is ~0.5 MB of JSON,
 * a usual one a few KB. 8 MB (~30 MB of heap for these short strings) keeps
 * thousands of usual users.
 */
const MEMORY_MEMBERSHIP_MAX_WEIGHT = 8 * 1024 * 1024;
/**
 * After a failed refresh, stream requests wait this long before they ask for
 * another: a Provider outage must not turn each request into a full read.
 */
const REFRESH_COOLDOWN_MS = 5 * 60_000;

export const EMPTY_MEMBERSHIP: Membership = {
  watchlist: [],
  watched: [],
  watchedEpisodes: [],
  ratings: {},
};

const storedMembershipSchema = z.object({
  fetchedAt: z.string(),
  revision: z.string().optional(),
  username: z.string().nullable(),
  membership: z.object({
    watchlist: z.array(z.string()),
    watched: z.array(z.string()),
    watchedEpisodes: z.array(z.string()),
    ratings: z.record(z.number()),
  }),
});
type StoredMembership = z.infer<typeof storedMembershipSchema>;

function membershipKey(accountId: string, provider: ProviderId): string {
  return `${connectionPrefix(accountId, provider)}membership.json`;
}

/** Copies of R2's membership objects; null when R2 has none. */
const memoryMembership = new LruCache<string, StoredMembership | null>({
  maxEntries: 10_000,
  maxWeight: MEMORY_MEMBERSHIP_MAX_WEIGHT,
  ttlMs: MEMORY_MEMBERSHIP_TTL_MS,
});

/** About the JSON length of a stored membership, without serializing it. */
function membershipWeight(stored: StoredMembership | null): number {
  if (!stored) return 100;
  const { watchlist, watched, watchedEpisodes, ratings } = stored.membership;
  return (
    200 +
    (watchlist.length + watched.length) * 13 +
    watchedEpisodes.length * 18 +
    Object.keys(ratings).length * 16
  );
}

function rememberMembership(
  key: string,
  stored: StoredMembership | null,
): void {
  memoryMembership.set(key, stored, { weight: membershipWeight(stored) });
}

/** A recent local snapshot for display only; mutations always read R2. */
export async function readMembership(
  accountId: string,
  provider: ProviderId,
  username: string | null,
): Promise<StoredMembership | null> {
  const key = membershipKey(accountId, provider);
  let stored = memoryMembership.get(key);
  if (stored === undefined) {
    try {
      stored = await readJson<StoredMembership>(key);
      rememberMembership(key, stored);
    } catch {
      // R2 is unreachable: use this instance's copy, and do not ask R2
      // again on every request until the copy expires.
      stored = memoryMembership.get(key);
      if (stored === undefined) {
        stored = null;
        rememberMembership(key, null);
      }
    }
  }
  return stored?.username === username ? stored : null;
}

/** Missing and existing snapshots both have an explicit write precondition. */
async function membershipVersion(key: string) {
  const version = await readJsonVersion(key);
  if (version && !version.etag) throw new Error("Membership has no ETag");
  return {
    stored: version ? storedMembershipSchema.parse(version.value) : null,
    etag: version?.etag ?? null,
  };
}

/** Merge just this successful Action, retrying against the winner of a race. */
export async function applyMembershipAction(
  connection: ConnectionAccess,
  intent: ActionIntent,
  target: ActionTarget,
): Promise<void> {
  const key = membershipKey(connection.accountId, connection.provider);
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const version = await membershipVersion(key);
      const previous =
        version.stored?.username === connection.username
          ? version.stored
          : null;
      const stored: StoredMembership = {
        // An Action changes one entry, not the age of the complete snapshot.
        fetchedAt: previous?.fetchedAt ?? new Date(0).toISOString(),
        // Even an idempotent Action invalidates an older full Provider read.
        revision: randomUUID(),
        username: connection.username,
        membership: applyToMembership(
          previous?.membership ?? EMPTY_MEMBERSHIP,
          intent,
          target,
        ),
      };
      try {
        await writeJson(key, stored, { etag: version.etag });
        // Write responses can finish out of order. Read the winning R2 state
        // on the next display instead of installing this writer's snapshot.
        memoryMembership.delete(key);
        return;
      } catch (error) {
        if (!isPreconditionFailed(error)) throw error;
      }
    }
    throw new Error("Membership remained busy after 8 attempts");
  } catch (error) {
    memoryMembership.delete(key);
    throw error;
  }
}

export function forgetMembership(
  accountId: string,
  provider: ProviderId,
): void {
  const key = membershipKey(accountId, provider);
  memoryMembership.delete(key);
  failedRefreshes.delete(key);
}

/** Membership keys with a refresh in flight on this instance. */
const refreshesInFlight = new Set<string>();
/** Membership keys whose last refresh failed, until the cooldown ends. */
const failedRefreshes = new LruCache<string, true>({
  maxEntries: 10_000,
  ttlMs: REFRESH_COOLDOWN_MS,
});

/**
 * Refresh a Connection's membership in the background. At most one refresh
 * per Connection runs on this instance: later requests join it by not
 * asking for another. After a failure (a failed refresh writes nothing, so
 * the membership stays stale), none starts until the cooldown ends.
 */
export function scheduleMembershipRefresh(
  accountId: string,
  provider: ProviderId,
): void {
  const key = membershipKey(accountId, provider);
  if (refreshesInFlight.has(key) || failedRefreshes.has(key)) return;
  refreshesInFlight.add(key);
  scheduleBackgroundTask(async () => {
    try {
      const actions = getProvider(provider).actions;
      const connection = await getConnectionAccess(accountId, provider);
      if (!actions || !connection) {
        failedRefreshes.set(key, true);
        return;
      }
      // Capture the version before the Provider read. A newer Action or
      // refresh wins; replaying this whole snapshot would erase its changes.
      const version = await membershipVersion(key);
      const membership = await actions.getMembership(connection);
      const stored: StoredMembership = {
        fetchedAt: new Date().toISOString(),
        username: connection.username,
        membership,
      };
      try {
        await writeJson(key, stored, { etag: version.etag });
      } catch (error) {
        if (!isPreconditionFailed(error)) throw error;
      } finally {
        // Write responses can finish out of order. Read the winning R2 state
        // on the next display instead of installing this writer's snapshot.
        memoryMembership.delete(key);
      }
    } catch (error) {
      failedRefreshes.set(key, true);
      console.error(
        `Refreshing ${provider} membership for ${accountId} failed, next try in ${REFRESH_COOLDOWN_MS / 60_000} minutes:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      refreshesInFlight.delete(key);
    }
  });
}

function applyToMembership(
  membership: Membership,
  intent: ActionIntent,
  target: ActionTarget,
): Membership {
  const next = structuredClone(membership);
  const toggle = (values: string[], value: string, add: boolean) => {
    const without = values.filter((v) => v !== value);
    return add ? [...without, value] : without;
  };
  if (intent.kind === "watchlist") {
    next.watchlist = toggle(next.watchlist, target.imdbId, intent.add);
  } else if (intent.kind === "watched") {
    if (target.episode) {
      next.watchedEpisodes = toggle(
        next.watchedEpisodes,
        `${target.imdbId}:${target.episode.season}:${target.episode.episode}`,
        intent.add,
      );
      if (intent.add) next.watched = toggle(next.watched, target.imdbId, true);
    } else {
      next.watched = toggle(next.watched, target.imdbId, intent.add);
    }
  } else if (intent.rating === null) {
    next.ratings = Object.fromEntries(
      Object.entries(next.ratings).filter(
        ([imdbId]) => imdbId !== target.imdbId,
      ),
    );
  } else {
    next.ratings[target.imdbId] = intent.rating;
  }
  return next;
}
