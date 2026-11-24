import { z } from "zod";
import { tmdbExternalIdsStrategy } from "../titles/tmdb";
import { OWN_LIST_FRESHNESS_MS, SHARED_LIST_FRESHNESS_MS } from "./freshness";
import { providerFetch, providerFetchJson } from "./http";
import { traktActions } from "./trakt/actions";
import {
  nonEmpty,
  TRAKT_API,
  traktGetAll,
  traktGetParsed,
  TRAKT_AUTH,
  traktClient,
  traktHeaders,
} from "./trakt/api";
import {
  isPersonal,
  parseTraktRef,
  readSource,
  smartListDisplayMode,
  validateTraktSource,
} from "./trakt/sources";
import type { ConnectionSource } from "@stremlist/shared/providers";
import type { ProviderAdapter } from "./types";
import { SourceUnavailableError } from "./types";

const traktOwnListSchema = z.object({
  name: z.string().optional(),
  media_type: z.string().nullish(),
  ids: z
    .object({ slug: z.string().optional(), trakt: z.number().optional() })
    .optional(),
});

type TraktOwnList = z.infer<typeof traktOwnListSchema>;

const traktOtherListSchema = traktOwnListSchema.extend({
  user: z
    .object({ ids: z.object({ slug: z.string().nullish() }).nullish() })
    .nullish(),
});
type TraktOtherList = z.infer<typeof traktOtherListSchema>;

const MAX_LIKED_LISTS = 500;

function otherListSource(list: TraktOtherList) {
  const owner = list.user?.ids?.slug;
  const id = list.ids?.slug ?? list.ids?.trakt;
  if (!owner || id === undefined) return [];
  return [
    {
      ref: `users/${owner}/lists/${String(id)}`.toLowerCase(),
      kind: "list",
      label: list.name?.trim() ? list.name.trim() : String(id),
      defaultDisplayMode: "split",
    } satisfies ConnectionSource,
  ];
}

async function optionalListing<T>(name: string, listing: Promise<T>) {
  try {
    return await listing;
  } catch (error) {
    console.error(
      `Listing Trakt ${name} failed:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

const traktSettingsSchema = z.object({
  user: z
    .object({
      username: z.string().nullish(),
      ids: z.object({ slug: z.string().nullish() }).optional(),
    })
    .optional(),
});

/**
 * Trakt: public watchlists and lists, official lists and charts with the
 * client ID only; with a Connection, the user's own Source lists and Actions.
 * Entries carry IMDb IDs in most cases; the rest resolve through TMDB.
 */
export const traktProvider: ProviderAdapter = {
  id: "trakt",
  freshnessMs: OWN_LIST_FRESHNESS_MS,

  freshnessFor(ref) {
    const source = parseTraktRef(ref);
    return source && !isPersonal(source)
      ? SHARED_LIST_FRESHNESS_MS
      : OWN_LIST_FRESHNESS_MS;
  },

  validateSource: validateTraktSource,

  async fetchSource(ref, ctx) {
    const source = parseTraktRef(ref);
    if (!source) {
      throw new SourceUnavailableError(
        "not_found",
        `Unknown Trakt source ${ref}`,
      );
    }
    return readSource(source, ctx);
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

  /**
   * The user's own lists and smart lists, then the lists that the user
   * likes or collaborates on, so the configure page can offer them in one
   * click.
   */
  async listConnectionSources(connection) {
    const [lists, smartLists, liked, collaborations] = await Promise.all([
      traktGetParsed(
        "/users/me/lists",
        z.array(traktOwnListSchema),
        connection,
      ),
      optionalListing(
        "smart lists",
        traktGetParsed(
          "/users/me/smart-lists",
          z.array(traktOwnListSchema),
          connection,
        ),
      ),
      optionalListing(
        "liked lists",
        traktGetAll(
          "/users/likes/lists",
          z.object({ list: traktOtherListSchema.nullish() }),
          connection,
          { maxItems: MAX_LIKED_LISTS },
        ),
      ),
      optionalListing(
        "collaboration lists",
        traktGetParsed(
          "/users/me/lists/collaborations",
          z.array(traktOtherListSchema),
          connection,
        ),
      ),
    ]);
    const toSources = (prefix: string, found: TraktOwnList[] | null) =>
      (found ?? []).flatMap((list) => {
        const id = list.ids?.slug ?? list.ids?.trakt;
        return id === undefined
          ? []
          : [
              {
                ref: `${prefix}/${String(id).toLowerCase()}`,
                kind: "list" as const,
                label: list.name?.trim() ? list.name.trim() : String(id),
                defaultDisplayMode: smartListDisplayMode(list.media_type),
              },
            ];
      });
    const ownIds = new Set((lists ?? []).map((list) => list.ids?.trakt));
    const others = new Map(
      [
        ...(liked?.items ?? []).flatMap(({ list }) => (list ? [list] : [])),
        ...(collaborations ?? []),
      ]
        .filter((list) => !ownIds.has(list.ids?.trakt))
        .flatMap(otherListSource)
        .map((source) => [source.ref, source]),
    );
    return [
      ...toSources("me/lists", lists),
      ...toSources("me/smart-lists", smartLists),
      ...others.values(),
    ];
  },

  oauth: {
    /** Trakt wants every OAuth call on its auth host, not the API host. */
    authorizeUrl: `${TRAKT_AUTH}/oauth/authorize`,
    tokenUrl: `${TRAKT_AUTH}/oauth/token`,
    ...traktClient,
    async revoke(accessToken) {
      const secret = traktClient.clientSecret();
      await providerFetch(`${TRAKT_AUTH}/oauth/revoke`, {
        method: "POST",
        json: {
          token: accessToken,
          client_id: traktClient.clientId(),
          ...(secret ? { client_secret: secret } : {}),
        },
      });
    },
    async fetchUsername(accessToken) {
      const { data } = await providerFetchJson(`${TRAKT_API}/users/settings`, {
        headers: traktHeaders(),
        bearer: accessToken,
      });
      const { user } = traktSettingsSchema.parse(data);
      return nonEmpty(user?.username) ?? nonEmpty(user?.ids?.slug);
    },
  },
};
