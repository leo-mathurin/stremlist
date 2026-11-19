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
import { targetEpisodes } from "../providers/types";
import { getConnectionAccess } from "./connections";

/** Membership older than this is refreshed in the background. */
export const MEMBERSHIP_FRESH_MS = 15 * 60_000;
const MEMORY_MEMBERSHIP_TTL_MS = 60_000;
const MEMORY_MEMBERSHIP_MAX_WEIGHT = 8 * 1024 * 1024;
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
  authorization: z.string().optional(),
  username: z.string().nullable().optional(),
  membership: z.object({
    watchlist: z.array(z.string()),
    watched: z.array(z.string()),
    watchedEpisodes: z.array(z.string()),
    ratings: z.record(z.string(), z.number()),
  }),
});
type StoredMembership = z.infer<typeof storedMembershipSchema>;

function membershipKey(accountId: string, provider: ProviderId) {
  return `${connectionPrefix(accountId, provider)}membership.json`;
}

const memoryMembership = new LruCache<string, StoredMembership | null>({
  maxEntries: 10_000,
  maxWeight: MEMORY_MEMBERSHIP_MAX_WEIGHT,
  ttlMs: MEMORY_MEMBERSHIP_TTL_MS,
});

function membershipWeight(stored: StoredMembership | null) {
  if (!stored) return 100;
  const { watchlist, watched, watchedEpisodes, ratings } = stored.membership;
  return (
    200 +
    (watchlist.length + watched.length) * 13 +
    watchedEpisodes.length * 18 +
    Object.keys(ratings).length * 16
  );
}

function rememberMembership(key: string, stored: StoredMembership | null) {
  memoryMembership.set(key, stored, { weight: membershipWeight(stored) });
}

/** Identifies one authorization of a Connection. */
interface MembershipOwner {
  username: string | null;
  authorization: string;
}

function ownedBy(
  stored: StoredMembership | null | undefined,
  owner: MembershipOwner,
): stored is StoredMembership {
  if (!stored) return false;
  return stored.authorization === undefined
    ? stored.username === owner.username
    : stored.authorization === owner.authorization;
}

/** A recent local snapshot for display only; mutations always read R2. */
export async function readMembership(
  accountId: string,
  provider: ProviderId,
  owner: MembershipOwner,
) {
  const key = membershipKey(accountId, provider);
  let stored = memoryMembership.get(key);
  if (stored === undefined) {
    try {
      stored = await readJson(key, storedMembershipSchema);
      rememberMembership(key, stored);
    } catch {
      stored = memoryMembership.get(key);
      if (stored === undefined) {
        stored = null;
        rememberMembership(key, null);
      }
    }
  }
  return ownedBy(stored, owner) ? stored : null;
}

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
) {
  const key = membershipKey(connection.accountId, connection.provider);
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const version = await membershipVersion(key);
      const previous = ownedBy(version.stored, connection)
        ? version.stored
        : null;
      const stored: StoredMembership = {
        fetchedAt: previous?.fetchedAt ?? new Date(0).toISOString(),
        revision: randomUUID(),
        authorization: connection.authorization,
        username: connection.username,
        membership: applyToMembership(
          previous?.membership ?? EMPTY_MEMBERSHIP,
          intent,
          target,
        ),
      };
      try {
        await writeJson(key, stored, { etag: version.etag });
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

export function forgetMembership(accountId: string, provider: ProviderId) {
  const key = membershipKey(accountId, provider);
  memoryMembership.delete(key);
  failedRefreshes.delete(key);
}

const refreshesInFlight = new Set<string>();
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
) {
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
      const version = await membershipVersion(key);
      const membership = await actions.getMembership(connection);
      const stored: StoredMembership = {
        fetchedAt: new Date().toISOString(),
        authorization: connection.authorization,
        username: connection.username,
        membership,
      };
      try {
        await writeJson(key, stored, { etag: version.etag });
      } catch (error) {
        if (!isPreconditionFailed(error)) throw error;
      } finally {
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
) {
  const next = structuredClone(membership);
  const toggle = (values: string[], value: string, add: boolean) => {
    const without = values.filter((v) => v !== value);
    return add ? [...without, value] : without;
  };
  if (intent.kind === "watchlist") {
    next.watchlist = toggle(next.watchlist, target.imdbId, intent.add);
  } else if (intent.kind === "watched") {
    const episodes = targetEpisodes(target);
    if (episodes.length > 0) {
      for (const { season, episode } of episodes) {
        next.watchedEpisodes = toggle(
          next.watchedEpisodes,
          `${target.imdbId}:${season}:${episode}`,
          intent.add,
        );
      }
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
