import {
  CONNECTION_SOURCES,
  sourceTitle,
  staticSource,
} from "@stremlist/shared/providers";
import { z } from "zod";
import { tmdbExternalIdsStrategy } from "../titles/tmdb";
import { revokeToken } from "./oauth-app";
import { simklActions } from "./simkl/actions";
import {
  SIMKL_API,
  simklClient,
  simklLimiters,
  simklRequest,
} from "./simkl/api";
import { LIBRARY_REFS, libraryEntries } from "./simkl/entries";
import {
  clearInFlightSyncs,
  forgetInFlightSync,
  syncLibrary,
} from "./simkl/library";
import { fetchCustomList, readListPage } from "./simkl/lists";
import { clearMemoryState, forgetMemoryState } from "./simkl/state";
import {
  clearTrendingReads,
  isTrendingRef,
  readTrending,
  TRENDING_FRESHNESS_MS,
} from "./simkl/trending";
import type { ProviderAdapter, SourceValidation } from "./types";
import { SourceUnavailableError } from "./types";

const LIST_REF = /^me\/lists\/(\d+)$/;

const simklSettingsSchema = z.object({
  user: z.object({ name: z.string().nullish() }).nullish(),
});

/** Test hook: forget the in-memory fallback state. */
export function resetSimklState(): void {
  clearMemoryState();
  clearInFlightSyncs();
  clearTrendingReads();
}

const LIBRARY_FRESHNESS_MS = 60 * 60_000;

/**
 * Simkl: the Connection's own statuses (`me/plantowatch`, `me/watching`,
 * `me/completed`, `me/hold`, `me/dropped`, with movies, shows and anime),
 * history and ratings, and custom lists (`me/lists/{id}`, Simkl PRO and VIP
 * only), through OAuth (AUTH V2). Reads follow Simkl's activities-first sync
 * model; the library snapshot lives in R2 under the Account's Connection.
 * The trending charts (`trending/movies`, `trending/tv`, `trending/anime`)
 * come from Simkl's CDN files, with no Connection and no user quota.
 */
export const simklProvider: ProviderAdapter = {
  id: "simkl",
  freshnessMs: LIBRARY_FRESHNESS_MS,

  freshnessFor(ref) {
    return isTrendingRef(ref) ? TRENDING_FRESHNESS_MS : LIBRARY_FRESHNESS_MS;
  },

  async validateSource(ref, ctx): Promise<SourceValidation> {
    if (isTrendingRef(ref)) {
      return {
        ok: true,
        ref,
        suggestedTitle: sourceTitle("simkl", ref),
        defaultDisplayMode: staticSource("simkl", ref)?.defaultDisplayMode,
      };
    }
    const fromLibrary = LIBRARY_REFS.includes(ref);
    const listId = LIST_REF.exec(ref)?.[1];
    if (!fromLibrary && !listId) return { ok: false, reason: "not_found" };
    if (!ctx.connection) return { ok: false, reason: "needs_connection" };

    if (fromLibrary) {
      const source = CONNECTION_SOURCES.simkl?.find(
        (entry) => entry.ref === ref,
      );
      return {
        ok: true,
        ref,
        suggestedTitle: source?.label,
        defaultDisplayMode: source?.defaultDisplayMode,
      };
    }
    const token = await ctx.connection.getAccessToken();
    const page = await readListPage(token, listId ?? "", 1, 1);
    return {
      ok: true,
      ref,
      suggestedTitle: page.name ?? undefined,
      defaultDisplayMode: page.media_type === "movies" ? "movie" : "series",
    };
  },

  async fetchSource(ref, ctx) {
    if (isTrendingRef(ref)) return readTrending(ref, ctx.forceRefresh);
    const listId = LIST_REF.exec(ref)?.[1];
    if (!LIBRARY_REFS.includes(ref) && !listId) {
      throw new SourceUnavailableError(
        "not_found",
        `Unknown Simkl source ${ref}`,
      );
    }
    const { connection } = ctx;
    if (!connection) {
      throw new SourceUnavailableError(
        "needs_connection",
        "Simkl lists need a Connection",
      );
    }
    if (listId) return fetchCustomList(connection, listId);
    const library = await syncLibrary(connection);
    return {
      entries: libraryEntries(library.items, ref),
      // The library sync has no page cap: it is the whole library.
      complete: true,
    };
  },

  resolutionKey(entry) {
    const simkl = entry.externalIds?.simkl;
    return simkl ? { namespace: "simkl", externalId: String(simkl) } : null;
  },

  // Anime often have no IMDb ID on Simkl, but many have a TMDB ID.
  resolverStrategies: [tmdbExternalIdsStrategy],

  actions: simklActions,

  forgetConnection(accountId) {
    forgetMemoryState(accountId);
    forgetInFlightSync(accountId);
  },

  oauth: {
    authorizeUrl: "https://simkl.com/oauth2/authorize",
    tokenUrl: `${SIMKL_API}/oauth2/token`,
    ...simklClient,
    // Without media:write (exact spelling), Simkl silently grants read-only.
    scopes: ["media:read", "media:write"],

    revoke: (token) =>
      revokeToken(
        `${SIMKL_API}/oauth2/revoke`,
        token,
        simklClient,
        simklLimiters(token).post,
      ),

    async fetchUsername(token) {
      const data = await simklRequest("/users/settings", simklSettingsSchema, {
        token,
      });
      const name = data.user?.name?.trim();
      if (!name) return null;
      return name;
    },
  },
};
