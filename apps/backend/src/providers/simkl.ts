import { CONNECTION_SOURCES } from "@stremlist/shared/providers";
import { tmdbExternalIdsStrategy } from "../titles/tmdb";
import { revokeToken } from "./oauth-app";
import { simklActions } from "./simkl/actions";
import { postLimiter, SIMKL_API, simklClient, simklRequest } from "./simkl/api";
import {
  historyEntries,
  HISTORY_REF,
  LIBRARY_REFS,
  STATUS_REFS,
  statusEntries,
} from "./simkl/entries";
import { clearInFlightSyncs, syncLibrary } from "./simkl/library";
import { fetchCustomList, readListPage } from "./simkl/lists";
import { clearMemoryState } from "./simkl/state";
import type {
  ConnectionAccess,
  ProviderAdapter,
  SourceValidation,
} from "./types";
import { connectionToken, SourceUnavailableError } from "./types";

export { simklItemUrl } from "./simkl/entries";

const LIST_REF = /^me\/lists\/(\d+)$/;

/** Test hook: forget the in-memory fallback state. */
export function resetSimklState(): void {
  clearMemoryState();
  clearInFlightSyncs();
}

function requireConnection(ctx: {
  connection: ConnectionAccess | null;
}): ConnectionAccess {
  if (!ctx.connection) {
    throw new SourceUnavailableError(
      "needs_connection",
      "Simkl lists need a Connection",
    );
  }
  return ctx.connection;
}

/**
 * Simkl: the Connection's own statuses (`me/plantowatch`, `me/watching`,
 * `me/completed`, `me/hold`, `me/dropped`, with movies, shows and anime) and
 * custom lists (`me/lists/{id}`, Simkl PRO and VIP only), through OAuth
 * (AUTH V2). Reads follow Simkl's activities-first sync model; the library
 * snapshot lives in R2 under the Account's Connection.
 */
export const simklProvider: ProviderAdapter = {
  id: "simkl",
  freshnessMs: 60 * 60_000,

  async validateSource(ref, ctx): Promise<SourceValidation> {
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
    try {
      const token = await connectionToken(ctx.connection);
      const page = await readListPage(token, listId ?? "", 1, 1);
      return {
        ok: true,
        ref,
        suggestedTitle: page.name,
        defaultDisplayMode: page.media_type === "movies" ? "movie" : "series",
      };
    } catch (error) {
      if (error instanceof SourceUnavailableError) {
        return { ok: false, reason: error.reason, message: error.message };
      }
      throw error;
    }
  },

  async fetchSource(ref, ctx) {
    const status = STATUS_REFS.get(ref);
    const listId = LIST_REF.exec(ref)?.[1];
    if (!status && !listId && ref !== HISTORY_REF) {
      throw new SourceUnavailableError(
        "not_found",
        `Unknown Simkl source ${ref}`,
      );
    }
    const connection = requireConnection(ctx);
    if (listId) return fetchCustomList(connection, listId);
    const library = await syncLibrary(connection);
    return {
      entries: status
        ? statusEntries(library.items, status)
        : historyEntries(library.items),
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
        postLimiter,
      ),

    async fetchUsername(token) {
      const data = await simklRequest<{ user?: { name?: string } }>(
        "/users/settings",
        {
          token,
        },
      );
      const name = data.user?.name?.trim();
      if (!name) return null;
      return name;
    },
  },
};
