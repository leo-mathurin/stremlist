import { tmdbExternalIdsStrategy } from "../titles/tmdb";
import { providerFetch, providerFetchJson } from "./http";
import { traktActions } from "./trakt/actions";
import {
  nonEmpty,
  TRAKT_API,
  TRAKT_AUTH,
  traktClientId,
  traktHeaders,
} from "./trakt/api";
import {
  isPersonal,
  parseTraktRef,
  readSource,
  validateTraktSource,
} from "./trakt/sources";
import type { ProviderAdapter } from "./types";
import { SourceUnavailableError } from "./types";

/** Public Source lists share the app's quota of 500 GETs per 5 minutes. */
const PUBLIC_FRESHNESS_MS = 6 * 60 * 60_000;
const PERSONAL_FRESHNESS_MS = 30 * 60_000;

function clientSecret(): string | undefined {
  return nonEmpty(process.env.TRAKT_CLIENT_SECRET) ?? undefined;
}

/**
 * Trakt: public watchlists and lists, official lists and charts with the
 * client ID only; with a Connection, the user's own Source lists and Actions.
 * Entries carry IMDb IDs in most cases; the rest resolve through TMDB.
 */
export const traktProvider: ProviderAdapter = {
  id: "trakt",
  freshnessMs: PERSONAL_FRESHNESS_MS,

  freshnessFor(ref) {
    const source = parseTraktRef(ref);
    return source && !isPersonal(source)
      ? PUBLIC_FRESHNESS_MS
      : PERSONAL_FRESHNESS_MS;
  },

  validateSource(ref, ctx) {
    return validateTraktSource(ref, ctx);
  },

  async fetchSource(ref, ctx) {
    const source = parseTraktRef(ref);
    if (!source) {
      throw new SourceUnavailableError(
        "not_found",
        `Unknown Trakt source ${ref}`,
      );
    }
    return { entries: await readSource(source, ctx) };
  },

  resolutionKey(entry) {
    const trakt = entry.externalIds?.trakt;
    if (trakt === undefined) return null;
    return {
      namespace: entry.type === "series" ? "trakt-show" : "trakt-movie",
      externalId: String(trakt),
    };
  },

  resolverStrategies: [tmdbExternalIdsStrategy],

  actions: traktActions,

  oauth: {
    // Trakt wants every OAuth call on its auth host, not the API host.
    authorizeUrl: `${TRAKT_AUTH}/oauth/authorize`,
    tokenUrl: `${TRAKT_AUTH}/oauth/token`,
    clientId: traktClientId,
    // A public PKCE client needs no secret; send it only when one is set.
    clientSecret,
    async revoke(accessToken) {
      const secret = clientSecret();
      await providerFetch(`${TRAKT_AUTH}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: accessToken,
          client_id: traktClientId(),
          ...(secret ? { client_secret: secret } : {}),
        }),
      });
    },
    async fetchUsername(accessToken) {
      const { data } = await providerFetchJson<{
        user?: { username?: string | null; ids?: { slug?: string | null } };
      }>(`${TRAKT_API}/users/settings`, { headers: traktHeaders(accessToken) });
      return nonEmpty(data.user?.username) ?? nonEmpty(data.user?.ids?.slug);
    },
  },
};
