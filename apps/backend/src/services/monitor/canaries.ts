import type { ProviderId } from "@stremlist/shared/providers";
import {
  isProviderId,
  listTypeOf,
  PROVIDER_IDS,
  sourceRequiresConnection,
} from "@stremlist/shared/providers";
import { CHART_BY_ID } from "@stremlist/shared/imdb-charts";
import { z } from "zod";
import { failureMessage } from "../../lib/connection-reset";
import {
  mayReadProvider,
  providerDegradation,
} from "../../providers/availability";
import { getProvider } from "../../providers/registry";
import type { ConnectionAccess } from "../../providers/types";
import { SourceBusyError } from "../../providers/types";
import { getConnectionAccess } from "../connections";

/**
 * How the monitor checks one list type: a Source list to read and the
 * fewest entries that a good read gives, or why no canary reads the type.
 * A silent failure (a read that stops after the first page, a kind of Title
 * that goes missing) gives no error, only fewer entries, so a canary checks
 * the count too.
 *
 * `ref` is the Source list to read for a type with variable parts, such as
 * `users/{user}/watchlist`. A type without one (a chart, `me/watchlist`)
 * reads the type itself. `MONITOR_CANARY_REFS` can replace both.
 */
export type CanarySpec = { min: number; ref?: string } | { none: string };

/**
 * One entry per list type of `listTypes()`. The coverage test fails when a
 * new list type has no entry, so new types are monitored or say why not.
 * Each `min` is about 80% of what the Source list gave when it was chosen
 * (charts that change a lot have less). A type with variable parts and no
 * `ref` is checked only when MONITOR_CANARY_REFS names a Source list for it.
 * Connection types read the Connection of MONITOR_ACCOUNT_ID: its user must
 * keep at least `min` Titles in each of them.
 */
export const CANARIES = {
  "imdb:chart/most-popular-movies": { min: 80 },
  "imdb:chart/most-popular-tv": { min: 80 },
  "imdb:chart/top-rated-movies": { min: 200 },
  "imdb:chart/top-rated-tv": { min: 200 },
  "imdb:chart/top-rated-english-movies": { min: 200 },
  "imdb:chart/top-rated-indian-movies": { min: 200 },
  "imdb:chart/top-rated-tamil-movies": { min: 200 },
  "imdb:chart/top-rated-telugu-movies": { min: 200 },
  "imdb:chart/top-rated-malayalam-movies": { min: 200 },
  "imdb:chart/lowest-rated-movies": { min: 80 },
  "imdb:chart/box-office": { min: 8 },
  "imdb:chart/coming-soon-movies": { min: 50 },
  "imdb:chart/coming-soon-tv": { min: 15 },
  "imdb:ls/list": { ref: "ls055592025", min: 80 },
  "imdb:ur/watchlist": { ref: "ur195879360", min: 60 },
  /** A small list: IMDb reads ratings slowly (about 5 s per 1,000). */
  "imdb:ur/ratings": { ref: "ur102185135/ratings", min: 50 },

  "trakt:me/watchlist": { min: 1 },
  "trakt:me/recommendations": { min: 5 },
  "trakt:me/up-next": {
    none: "Up Next has only the series that the user is watching, which a monitor Account cannot keep.",
  },
  "trakt:me/continue-watching": {
    none: "Continue Watching has only the movies and episodes that the user paused and did not finish, which a monitor Account cannot keep.",
  },
  "trakt:me/calendar": {
    none: "The Calendar has only what airs in the next 30 days for the user's shows and movies, which a monitor Account cannot keep. The public calendars check the same rows.",
  },
  "trakt:me/history": { min: 1 },
  "trakt:me/collection": { min: 1 },
  "trakt:me/favorites": { min: 1 },
  "trakt:me/ratings": { min: 1 },
  "trakt:trending": { min: 50 },
  "trakt:popular": { min: 50 },
  "trakt:anticipated": { min: 50 },
  /** Trakt's box office has the 10 movies of the weekend. */
  "trakt:boxoffice": { min: 5 },
  "trakt:watched": { min: 50 },
  "trakt:played": { min: 50 },
  "trakt:collected": { min: 50 },
  "trakt:favorited": { min: 50 },
  "trakt:recommended": { min: 50 },
  /**
   * Calendars of the next 30 days. On 2026-11-17 they gave 9 new shows, 35
   * season premieres, 28 movies and 40 DVD releases; they change a lot.
   */
  "trakt:calendars/shows/new": { min: 3 },
  "trakt:calendars/shows/premieres": { min: 15 },
  "trakt:calendars/movies": { min: 10 },
  "trakt:calendars/dvd": { min: 15 },
  /**
   * A public user's history or collection costs up to about 20 calls of
   * the app-wide quota: give a small one in MONITOR_CANARY_REFS.
   */
  "trakt:users/{user}/watchlist": { min: 1 },
  "trakt:users/{user}/favorites": { min: 1 },
  "trakt:users/{user}/ratings": { min: 1 },
  "trakt:users/{user}/history": { min: 1 },
  "trakt:users/{user}/collection": { min: 1 },
  "trakt:users/{user}/lists/{list}": { min: 1 },
  "trakt:lists/{list}": { min: 1 },
  "trakt:smart-lists/{slug}": { min: 1 },
  "trakt:me/smart-lists/{slug}": { min: 1 },
  "trakt:me/lists/{list}": { min: 1 },

  "simkl:me/plantowatch": { min: 1 },
  "simkl:me/watching": { min: 1 },
  "simkl:me/completed": { min: 1 },
  "simkl:me/hold": { min: 1 },
  "simkl:me/dropped": { min: 1 },
  "simkl:me/history": { min: 1 },
  "simkl:me/ratings": { min: 1 },
  "simkl:me/airing-soon": {
    none: "Airing soon has only the Titles of the library that air in the next weeks, which a monitor Account cannot keep. It reads the same library as the statuses.",
  },
  "simkl:me/continue-watching": {
    none: "Simkl drops a paused playback session after 7 days on a free account, so a monitor Account cannot keep one.",
  },
  /**
   * Simkl's CDN files list 100 Titles each. In the anime files, seasons
   * share the series' IMDb ID: about 80 Titles stay (2026-11-17).
   */
  "simkl:trending/movies/today": { min: 80 },
  "simkl:trending/tv/today": { min: 80 },
  "simkl:trending/anime/today": { min: 64 },
  "simkl:trending/movies": { min: 50 },
  "simkl:trending/tv": { min: 50 },
  "simkl:trending/anime": { min: 50 },
  "simkl:trending/movies/month": { min: 80 },
  "simkl:trending/tv/month": { min: 80 },
  "simkl:trending/anime/month": { min: 64 },
  "simkl:dvd/releases": { min: 80 },
  "simkl:me/lists/{id}": {
    none: "Custom lists need Simkl PRO or VIP, and they read the same library as the statuses.",
  },
  /** A genre's file has the 500 trending Titles of the month. */
  "simkl:trending/{type}/genre/{slug}": {
    ref: "trending/movies/genre/horror",
    min: 400,
  },

  "mdblist:me/watchlist": { min: 1 },
  "mdblist:me/ratings": { min: 1 },
  "mdblist:me/history": { min: 1 },
  "mdblist:me/up-next": {
    none: "Up Next has only the series that the user is watching, which a monitor Account cannot keep.",
  },
  "mdblist:me/collection": {
    none: "The monitor Account keeps no Title in its MDBList collection. Add one, then give this type min: 1.",
  },
  /**
   * MDBList reads its official charts and recommendations through the
   * Connection too. Each chart gives the same count every day (100 or 200
   * Titles; about 300 for JustWatch), so the minimums are about 80% of a
   * read on 2026-11-17.
   */
  "mdblist:official/trending": { min: 160 },
  "mdblist:official/popular": { min: 160 },
  "mdblist:official/anticipated": { min: 80 },
  "mdblist:official/most-watched": { min: 160 },
  "mdblist:official/most-watched-week": { min: 80 },
  "mdblist:official/moviemeter": { min: 160 },
  "mdblist:official/justwatch-streaming-charts": { min: 240 },
  "mdblist:official/{slug}": {
    none: "Another official chart reads the same endpoint as the official charts that have their canaries.",
  },
  "mdblist:recommended/rising": { min: 80 },
  "mdblist:recommended/{section}": {
    none: "The other sections need an MDBList supporter plan, and they read the same endpoint as recommended/rising.",
  },
  "mdblist:lists/{id}": { min: 1 },
  "mdblist:lists/{user}/{slug}": {
    none: "Validation stores a pasted list link as lists/{id}.",
  },
  "mdblist:watchlist/{user}": {
    none: "Validation stores a pasted watchlist link as me/watchlist.",
  },
  "mdblist:me/lists/{id}": { min: 1 },
  "mdblist:me/external/{id}": { min: 1 },

  "justwatch:{list}": { ref: "tl-tu-12653", min: 3 },

  "senscritique:users/{user}/wishes": {
    ref: "users/Sergent_Pepper/wishes",
    min: 700,
  },
  "senscritique:lists/{id}": { ref: "lists/369869", min: 35 },
  /**
   * The same public user for the collections. A first read resolves
   * the Titles slowly, so the counts grow over the first runs.
   */
  "senscritique:users/{user}/done": { ref: "users/Plume231/done", min: 320 },
  "senscritique:users/{user}/rated": { ref: "users/Plume231/rated", min: 400 },
  "senscritique:users/{user}/recommend": {
    ref: "users/Plume231/recommend",
    min: 100,
  },
  /** 744 of 762 resolved on 2026-11-17. */
  "senscritique:users/{user}/liked": { ref: "users/Plume231/liked", min: 595 },
  /** Plume231 has nothing in progress. kYrios had 72 of 75 resolved. */
  "senscritique:users/{user}/current": {
    ref: "users/kYrios/current",
    min: 55,
  },
  /** A past year does not change: 244 of 253 resolved. */
  "senscritique:users/{user}/done/{year}": {
    ref: "users/Sergent_Pepper/done/2024",
    min: 195,
  },
  "senscritique:top111-movies": { min: 80 },
  "senscritique:top111-series": { min: 75 },
  "senscritique:top100-movies": { min: 80 },
  "senscritique:top100-series": { min: 75 },
  /** Anime titles resolve less well: 76 of 150 resolved. */
  "senscritique:top111-anime": { min: 60 },
  "senscritique:polls/{id}": { ref: "polls/3996052", min: 80 },

  "letterboxd:share/{token}": {
    none: "A Share link is secret, and Letterboxd reads it as the same list page as users/{user}/lists/{slug}.",
  },
  "letterboxd:users/{user}/lists/{slug}": {
    ref: "users/official/lists/letterboxds-top-500-films",
    min: 400,
  },
  "letterboxd:users/{user}/watchlist": { min: 1 },
  "letterboxd:users/{user}/diary": { min: 1 },
  "letterboxd:users/{user}/films/rated/{range}": { min: 1 },
  "letterboxd:users/{user}/films": { min: 1 },
  "letterboxd:users/{user}/likes/films": { min: 1 },
} satisfies Record<string, CanarySpec>;

const canaryOf = { type: z.string(), provider: z.enum(PROVIDER_IDS) };

/** What one canary found. `ref` is absent when no canary reads the type. */
export const canaryResultSchema = z.discriminatedUnion("status", [
  z.object({
    ...canaryOf,
    status: z.literal("ok"),
    ref: z.string(),
    entries: z.number(),
    min: z.number(),
  }),
  z.object({
    ...canaryOf,
    status: z.literal("failed"),
    ref: z.string(),
    error: z.string(),
    entries: z.number().optional(),
    min: z.number(),
  }),
  z.object({
    ...canaryOf,
    status: z.literal("skipped"),
    ref: z.string(),
    reason: z.string(),
  }),
  z.object({
    ...canaryOf,
    status: z.literal("not_covered"),
    reason: z.string(),
  }),
]);
export type CanaryResult = z.infer<typeof canaryResultSchema>;

function env(name: string) {
  const value = process.env[name]?.trim();
  return value === "" ? undefined : value;
}

function providerOf(type: string) {
  const provider = type.slice(0, type.indexOf(":"));
  if (!isProviderId(provider)) throw new Error(`Unknown list type ${type}`);
  return provider;
}

function fixedRef(type: string) {
  const ref = type.slice(type.indexOf(":") + 1);
  if (ref.includes("{")) return undefined;
  if (ref.startsWith("chart/")) {
    const id = `imdb:${ref.slice("chart/".length)}`;
    return CHART_BY_ID.has(id) ? id : undefined;
  }
  return ref;
}

/**
 * The Source lists that MONITOR_CANARY_REFS sets, by list type. Entries are
 * `provider:ref` or `provider:ref=min`, separated by spaces or commas, such
 * as `trakt:users/alice/watchlist=40`.
 */
export function canaryRefsFromEnv(value = env("MONITOR_CANARY_REFS")) {
  const refs = new Map<string, { ref: string; min?: number }>();
  for (const entry of value?.split(/[\s,]+/) ?? []) {
    const match = /^([a-z]+):(.+?)(?:=(\d+))?$/.exec(entry);
    if (!match || !isProviderId(match[1])) {
      if (entry) console.error(`Ignoring MONITOR_CANARY_REFS entry ${entry}`);
      continue;
    }
    const [, provider, ref, min] = match;
    if (!isProviderId(provider)) continue;
    refs.set(listTypeOf(provider, ref), {
      ref,
      min: min === undefined ? undefined : Number(min),
    });
  }
  return refs;
}

interface Canary {
  type: string;
  provider: ProviderId;
  ref: string;
  min: number;
}

/** The canaries to read, and the list types that none reads. */
export function plannedCanaries(refs = canaryRefsFromEnv()) {
  const planned: (Canary | Extract<CanaryResult, { status: "not_covered" }>)[] =
    Object.entries<CanarySpec>(CANARIES).map(([type, spec]) => {
      const provider = providerOf(type);
      if ("none" in spec)
        return { type, provider, status: "not_covered", reason: spec.none };
      const set = refs.get(type);
      const ref = set?.ref ?? spec.ref ?? fixedRef(type);
      if (!ref)
        return {
          type,
          provider,
          status: "not_covered",
          reason: "No Source list: add one to MONITOR_CANARY_REFS",
        };
      return { type, provider, ref, min: set?.min ?? spec.min };
    });
  return planned;
}

async function providerBlocker(provider: ProviderId) {
  if (!(await mayReadProvider(provider)))
    return `${provider} is unavailable (turned off or halted)`;
  const degraded = await providerDegradation(provider);
  if (degraded) return degraded;
  const { oauth } = getProvider(provider);
  if (oauth && !oauth.clientId()) return `The ${provider} app is not set`;
  return null;
}

async function monitorConnection(provider: ProviderId) {
  const accountId = env("MONITOR_ACCOUNT_ID");
  if (!accountId) return "MONITOR_ACCOUNT_ID is not set";
  try {
    return (
      (await getConnectionAccess(accountId, provider)) ??
      `The monitor Account has no ${provider} Connection`
    );
  } catch (error) {
    return `The monitor Account's ${provider} Connection cannot be read: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function readCanary(canary: Canary, connection: ConnectionAccess | null) {
  const { type, provider, ref, min } = canary;
  try {
    const snapshot = await getProvider(provider).fetchSource(ref, {
      connection,
      forceRefresh: true,
    });
    if (snapshot.interrupted)
      return {
        type,
        provider,
        ref,
        status: "skipped",
        reason: "The read waited for the Provider's queue",
      } satisfies CanaryResult;
    const entries = snapshot.entries.length;
    if (entries < min)
      return {
        type,
        provider,
        ref,
        status: "failed",
        entries,
        min,
        error: `${entries} entries, expected at least ${min}`,
      } satisfies CanaryResult;
    return {
      type,
      provider,
      ref,
      status: "ok",
      entries,
      min,
    } satisfies CanaryResult;
  } catch (error) {
    if (error instanceof SourceBusyError)
      return {
        type,
        provider,
        ref,
        status: "skipped",
        reason: error.message,
      } satisfies CanaryResult;
    return {
      type,
      provider,
      ref,
      status: "failed",
      min,
      error: failureMessage(error),
    } satisfies CanaryResult;
  }
}

async function runProviderCanaries(
  provider: ProviderId,
  planned: ReturnType<typeof plannedCanaries>,
) {
  const mine = planned.filter((canary) => canary.provider === provider);
  const blocker = mine.some((canary) => !("status" in canary))
    ? await providerBlocker(provider)
    : null;
  let connection: ConnectionAccess | string | undefined;
  const results: CanaryResult[] = [];
  for (const canary of mine) {
    if ("status" in canary) {
      results.push(canary);
      continue;
    }
    const { type, ref } = canary;
    if (blocker) {
      results.push({ type, provider, status: "not_covered", reason: blocker });
      continue;
    }
    if (!sourceRequiresConnection(provider, ref)) {
      results.push(await readCanary(canary, null));
      continue;
    }
    connection ??= await monitorConnection(provider);
    results.push(
      typeof connection === "string"
        ? { type, provider, status: "not_covered", reason: connection }
        : await readCanary(canary, connection),
    );
  }
  return results;
}

/**
 * Read one canary per list type of `providers`: the Providers at the same
 * time, the canaries of one Provider one after the other, to stay far below
 * each Provider's rate limits.
 */
export async function runCanaries(
  providers: readonly ProviderId[] = PROVIDER_IDS,
) {
  const planned = plannedCanaries();
  const results = await Promise.all(
    providers.map((provider) => runProviderCanaries(provider, planned)),
  );
  return results.flat();
}
