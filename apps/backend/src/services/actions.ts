import { IMDB_TITLE_ID_PATTERN } from "@stremlist/shared/constants";
import type { ActionKind, ProviderId } from "@stremlist/shared/providers";
import { joinProviderLabels, PROVIDERS } from "@stremlist/shared/providers";
import type { StremioStream } from "@stremlist/shared/stremio.types";
import { scheduleBackgroundTask } from "../lib/background";
import { LruCache } from "../lib/lru";
import {
  connectionPrefix,
  deletePrefix,
  readJson,
  writeJson,
} from "../lib/r2-json";
import {
  getProvider,
  isProviderEnabled,
  supportsAction,
} from "../providers/registry";
import type {
  ActionIntent,
  ActionTarget,
  ConnectionAccess,
  Membership,
} from "../providers/types";
import type { Account } from "./accounts";
import { getAccountLists } from "./accounts";
import { getConnectionAccess, listConnections } from "./connections";
import { markCachedListStale } from "./list-cache";
import { sourceCaches } from "./merged-lists";

/** Membership older than this is refreshed in the background. */
const MEMBERSHIP_FRESH_MS = 15 * 60_000;
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
const STREAM_NAME = "Stremlist";

const EMPTY_MEMBERSHIP: Membership = {
  watchlist: [],
  watched: [],
  watchedEpisodes: [],
  ratings: {},
};

interface StoredMembership {
  fetchedAt: string;
  /** The Provider user it was read for: a new Connection may be another one. */
  username: string | null;
  membership: Membership;
}

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

/**
 * The stored membership of the connected Provider user, or null. With
 * `fresh`, read R2 even when this instance has a recent copy (before a change
 * is written on top of it).
 */
async function readMembership(
  accountId: string,
  provider: ProviderId,
  username: string | null,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<StoredMembership | null> {
  const key = membershipKey(accountId, provider);
  let stored = fresh ? undefined : memoryMembership.get(key);
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

async function writeMembership(
  connection: ConnectionAccess,
  membership: Membership,
): Promise<void> {
  const key = membershipKey(connection.accountId, connection.provider);
  const stored: StoredMembership = {
    fetchedAt: new Date().toISOString(),
    username: connection.username,
    membership,
  };
  rememberMembership(key, stored);
  await writeJson(key, stored);
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
function scheduleMembershipRefresh(
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
      await writeMembership(
        connection,
        await actions.getMembership(connection),
      );
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

/**
 * After a disconnect: delete what Stremlist stored for that Connection, in
 * memory and in R2 (Action membership, and the Provider's own state such as
 * Simkl's library and custom list snapshots).
 */
export async function forgetConnectionObjects(
  accountId: string,
  provider: ProviderId,
): Promise<void> {
  forgetConnectionMemory(accountId, provider);
  await deletePrefix(connectionPrefix(accountId, provider));
}

/** Reauthorization replaces snapshots, but the same user's history survives. */
export async function resetConnectionCaches(
  accountId: string,
  provider: ProviderId,
): Promise<void> {
  forgetConnectionMemory(accountId, provider);
  const prefix = connectionPrefix(accountId, provider);
  await deletePrefix(prefix, `${prefix}history/`);
}

function forgetConnectionMemory(accountId: string, provider: ProviderId): void {
  const key = membershipKey(accountId, provider);
  memoryMembership.delete(key);
  failedRefreshes.delete(key);
  getProvider(provider).forgetConnection?.(accountId);
}

/**
 * The Connections that receive Actions for this Account, in the user's
 * order, with the connected Provider user.
 */
async function actionConnections(
  account: Account,
): Promise<{ provider: ProviderId; username: string | null }[]> {
  if (!account.actionsEnabled) return [];
  const connected = new Map(
    (await listConnections(account.id)).map((c) => [c.provider, c.username]),
  );
  return account.actionProviders.flatMap((provider) =>
    connected.has(provider) &&
    isProviderEnabled(provider) &&
    getProvider(provider).actions
      ? [{ provider, username: connected.get(provider) ?? null }]
      : [],
  );
}

/** The Providers that receive Actions for this Account, in the user's order. */
export async function actionProviders(account: Account): Promise<ProviderId[]> {
  return (await actionConnections(account)).map(({ provider }) => provider);
}

/** "tt123:2:5" → the series ID and the episode. */
export function parseStreamId(
  type: "movie" | "series",
  id: string,
): ActionTarget | null {
  const [imdbId, season, episode] = id.split(":");
  if (!IMDB_TITLE_ID_PATTERN.test(imdbId)) return null;
  if (type === "series" && season && episode) {
    const s = Number(season);
    const e = Number(episode);
    if (Number.isInteger(s) && Number.isInteger(e)) {
      return { imdbId, type, episode: { season: s, episode: e } };
    }
  }
  return { imdbId, type };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

type ActionLinkBuilder = (
  kind: ActionKind,
  op: "add" | "remove" | "rate",
) => string;

interface SlotMember {
  provider: ProviderId;
  has: boolean;
}

/**
 * One slot (watchlist or watched) as stream entries: one entry when every
 * Provider agrees, two when they differ (ADR 0003, mockup in STR-16).
 */
function slotEntries(
  members: SlotMember[],
  labels: {
    add: (single: string | null) => string;
    has: (names: string) => string;
    remove: string;
    alreadyNote: string;
    undo: string;
  },
  link: (op: "add" | "remove") => string,
): StremioStream[] {
  const withIt = members.filter((m) => m.has).map((m) => m.provider);
  const without = members.filter((m) => !m.has).map((m) => m.provider);
  const single =
    members.length === 1 ? PROVIDERS[members[0].provider].label : null;

  if (without.length === 0) {
    return [
      {
        name: STREAM_NAME,
        title: `${labels.has(joinProviderLabels(withIt))}\n${labels.undo}`,
        externalUrl: link("remove"),
      },
    ];
  }
  if (withIt.length === 0) {
    return [
      {
        name: STREAM_NAME,
        title: single
          ? labels.add(single)
          : `${labels.add(null)}\n${joinProviderLabels(without)}`,
        externalUrl: link("add"),
      },
    ];
  }
  return [
    {
      name: STREAM_NAME,
      title: `${labels.add(null)}\n${joinProviderLabels(without)} (${labels.alreadyNote} ${joinProviderLabels(withIt)})`,
      externalUrl: link("add"),
    },
    {
      name: STREAM_NAME,
      title: `${labels.remove}\n${joinProviderLabels(withIt)}`,
      externalUrl: link("remove"),
    },
  ];
}

/**
 * Action entries for a Title, in a fixed order: watchlist, watched, rate.
 * Rendered from cached membership only: opening a title never waits for a
 * Provider. Stale membership is refreshed in the background.
 */
export async function buildActionStreams(
  account: Account,
  target: ActionTarget,
  link: ActionLinkBuilder,
): Promise<StremioStream[]> {
  const connections = await actionConnections(account);
  if (connections.length === 0) return [];

  const memberships = await Promise.all(
    connections.map(async ({ provider, username }) => {
      const stored = await readMembership(account.id, provider, username);
      if (
        !stored ||
        Date.now() - new Date(stored.fetchedAt).getTime() > MEMBERSHIP_FRESH_MS
      ) {
        scheduleMembershipRefresh(account.id, provider);
      }
      return { provider, membership: stored?.membership ?? EMPTY_MEMBERSHIP };
    }),
  );

  const supporting = (kind: ActionKind) =>
    memberships.filter(({ provider }) => supportsAction(provider, kind));

  const streams: StremioStream[] = [];
  const { imdbId, episode } = target;

  const watchlistMembers = supporting("watchlist").map(
    ({ provider, membership }) => ({
      provider,
      has: membership.watchlist.includes(imdbId),
    }),
  );
  if (watchlistMembers.length > 0) {
    const single = watchlistMembers.length === 1;
    streams.push(
      ...slotEntries(
        watchlistMembers,
        {
          add: (name) =>
            name ? `🔖 Add to ${name} watchlist` : "🔖 Add to watchlist",
          has: (names) =>
            single
              ? `🔖 In your ${names} watchlist`
              : `🔖 In watchlist on ${names}`,
          remove: "🔖 Remove from watchlist",
          alreadyNote: "already on",
          undo: single ? "Select to remove" : "Select to remove from all",
        },
        (op) => link("watchlist", op),
      ),
    );
  }

  const episodeKey = episode
    ? `${imdbId}:${episode.season}:${episode.episode}`
    : null;
  const episodeLabel = episode
    ? `S${pad(episode.season)}E${pad(episode.episode)}`
    : null;
  const watchedMembers = supporting("watched").map(
    ({ provider, membership }) => ({
      provider,
      has: episodeKey
        ? membership.watchedEpisodes.includes(episodeKey)
        : membership.watched.includes(imdbId),
    }),
  );
  if (watchedMembers.length > 0) {
    const single = watchedMembers.length === 1;
    const what = episodeLabel
      ? `Mark ${episodeLabel} as watched`
      : "Mark as watched";
    streams.push(
      ...slotEntries(
        watchedMembers,
        {
          add: (name) => (name ? `✅ ${what} on ${name}` : `✅ ${what}`),
          has: (names) =>
            episodeLabel
              ? `✅ ${episodeLabel} watched on ${names}`
              : `✅ Watched on ${names}`,
          remove: "✅ Mark as unwatched",
          alreadyNote: "already watched on",
          undo: single
            ? "Select to mark as unwatched"
            : "Select to mark as unwatched everywhere",
        },
        (op) => link("watched", op),
      ),
    );
  }

  const raters = supporting("rating");
  if (raters.length > 0) {
    const ratings = raters
      .map(({ provider, membership }) => ({
        provider,
        rating: membership.ratings[imdbId],
      }))
      .filter(
        (r): r is { provider: ProviderId; rating: number } =>
          typeof r.rating === "number",
      );
    const names = joinProviderLabels(raters.map((r) => r.provider));
    const series = target.type === "series" ? " series" : "";
    let title: string;
    if (ratings.length === 0) {
      title =
        raters.length === 1
          ? `⭐ Rate${series} on ${names}`
          : `⭐ Rate${series}\nFrom 1 to 10 on ${names}`;
    } else if (
      ratings.length === raters.length &&
      new Set(ratings.map((r) => r.rating)).size === 1
    ) {
      title = `⭐ Rated ${ratings[0].rating}/10, change\n${names}`;
    } else if (ratings.length < raters.length) {
      // Say where the rating is, and where it is still missing.
      const rated = new Set(ratings.map((r) => r.provider));
      const missing = joinProviderLabels(
        raters.map((r) => r.provider).filter((p) => !rated.has(p)),
      );
      title = `⭐ ${ratings.map((r) => `${r.rating}/10 on ${PROVIDERS[r.provider].label}`).join(", ")}, change\nNot rated on ${missing}`;
    } else {
      title = `⭐ ${ratings.map((r) => `${r.rating}/10 on ${PROVIDERS[r.provider].label}`).join(", ")}, change`;
    }
    streams.push({
      name: STREAM_NAME,
      title,
      externalUrl: link("rating", "rate"),
    });
  }

  return streams;
}

export interface ActionOutcome {
  provider: ProviderId;
  ok: boolean;
  error?: string;
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

/**
 * Run an Action on each selected Provider. Afterwards the cached membership is
 * updated and the Catalogs whose Source lists changed are marked stale.
 */
export async function performAction(
  account: Account,
  providers: ProviderId[],
  intent: ActionIntent,
  target: ActionTarget,
): Promise<ActionOutcome[]> {
  const allowed = new Set(await actionProviders(account));
  const lists = await getAccountLists(account.id);

  return Promise.all(
    providers.map(async (provider): Promise<ActionOutcome> => {
      const actions = getProvider(provider).actions;
      if (
        !actions ||
        !allowed.has(provider) ||
        !supportsAction(provider, intent.kind)
      ) {
        return { provider, ok: false, error: "not_available" };
      }
      const connection = await getConnectionAccess(account.id, provider);
      if (!connection) return { provider, ok: false, error: "not_connected" };
      try {
        await actions.perform(connection, intent, target);
      } catch (error) {
        console.error(
          `Action ${intent.kind} on ${provider} failed for ${account.id}:`,
          error instanceof Error ? error.message : error,
        );
        return { provider, ok: false, error: "provider_error" };
      }

      try {
        const stored = await readMembership(
          account.id,
          provider,
          connection.username,
          { fresh: true },
        );
        await writeMembership(
          connection,
          applyToMembership(
            stored?.membership ?? EMPTY_MEMBERSHIP,
            intent,
            target,
          ),
        );
        const affected = new Set(actions.affectedSources(intent));
        await Promise.all(
          lists
            .flatMap(sourceCaches)
            .filter(
              ({ source }) =>
                source.provider === provider && affected.has(source.sourceRef),
            )
            .map(({ cacheKey }) => markCachedListStale(cacheKey)),
        );
      } catch (error) {
        console.error(
          `Updating caches after an action on ${provider} failed:`,
          error instanceof Error ? error.message : error,
        );
      }
      return { provider, ok: true };
    }),
  );
}

/** Current rating of a Title on each Provider, for the rating page. */
export async function currentRatings(
  account: Account,
  imdbId: string,
): Promise<{ provider: ProviderId; rating: number | null }[]> {
  const connections = (await actionConnections(account)).filter(
    ({ provider }) => supportsAction(provider, "rating"),
  );
  return Promise.all(
    connections.map(async ({ provider, username }) => {
      const stored = await readMembership(account.id, provider, username);
      return { provider, rating: stored?.membership.ratings[imdbId] ?? null };
    }),
  );
}
