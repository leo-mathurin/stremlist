import {
  isSensCritiqueCollection,
  SENSCRITIQUE_COLLECTIONS,
} from "@stremlist/shared/providers";
import type { SensCritiqueCollection } from "@stremlist/shared/providers";
import { z } from "zod";
import { justwatchPathStrategy } from "../titles/justwatch-lookup";
import { tmdbSearchMatchStrategy } from "../titles/tmdb-match";
import { wikidataStrategy } from "../titles/wikidata";
import { graphqlRequest, RateLimiter } from "./http";
import { readPages } from "./paging";
import type { PagedRead, ProviderAdapter, SourceEntry } from "./types";
import { SourceUnavailableError } from "./types";

const SENSCRITIQUE_GRAPHQL = "https://apollo.senscritique.com/";
const senscritiqueLimiter = new RateLimiter(3, 1000);
const QUERY_TIMEOUT_MS = 8_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

const UNIVERSE_MOVIE = 1;
const UNIVERSE_SERIES = 4;

const WIKIDATA_SENSCRITIQUE_WORK = "P10100";

const USER_REF = /^users\/([\w.-]+)\/([a-z]+)$/;
const LIST_REF = /^lists\/(\d+)$/;
const POLL_REF = /^polls\/(\d+)$/;

type Universe = "movie" | "tvShow";
type CollectionAction =
  (typeof SENSCRITIQUE_COLLECTIONS)[SensCritiqueCollection]["action"];

interface Chart {
  subtype: "TOP_111" | "TOP_100_OUT_OF_TOP_10";
  universe: Universe;
}

const CHARTS = new Map<string, Chart>([
  ["top111-movies", { subtype: "TOP_111", universe: "movie" }],
  ["top111-series", { subtype: "TOP_111", universe: "tvShow" }],
  ["top100-movies", { subtype: "TOP_100_OUT_OF_TOP_10", universe: "movie" }],
  ["top100-series", { subtype: "TOP_100_OUT_OF_TOP_10", universe: "tvShow" }],
]);
const CHART_LIMIT = 200;

function collectionReads(collection: SensCritiqueCollection) {
  const { action } = SENSCRITIQUE_COLLECTIONS[collection];
  const reads: [Universe, CollectionAction][] = [
    ["movie", action],
    ["tvShow", action],
  ];
  if (collection === "done") reads.push(["tvShow", "RATING"]);
  return reads;
}

function userRef(ref: string) {
  const match = USER_REF.exec(ref);
  return match && isSensCritiqueCollection(match[2])
    ? [match[1], match[2]]
    : null;
}

const personSchema = z.object({ name: z.string().nullish() });

const senscritiqueProductSchema = z.object({
  id: z.number(),
  title: z.string().nullish(),
  originalTitle: z.string().nullish(),
  yearOfProduction: z.number().nullish(),
  dateReleaseOriginal: z.string().nullish(),
  dateRelease: z.string().nullish(),
  duration: z.number().nullish(),
  universe: z.number().nullish(),
  directors: z.array(personSchema).nullish(),
  creators: z.array(personSchema).nullish(),
  providers: z
    .array(z.object({ justwatchUrl: z.string().nullish() }))
    .nullish(),
  otherUserInfos: z.object({ id: z.number().nullish() }).nullish(),
});
export type SensCritiqueProduct = z.infer<typeof senscritiqueProductSchema>;

const PRODUCT_FIELDS = `
  id
  title
  originalTitle
  yearOfProduction
  dateReleaseOriginal
  dateRelease
  duration
  universe
  directors { name }
  creators { name }
  providers { justwatchUrl }
`;

const USER_QUERY = `
  query StremlistUser($username: String!) {
    user(username: $username) {
      username
      settings { privacyProfile }
    }
  }
`;

const COLLECTION_QUERY = `
  query StremlistCollection($username: String!, $action: ProductAction!, $universe: String, $limit: Int, $offset: Int) {
    user(username: $username) {
      username
      settings { privacyProfile }
      collection(universe: $universe, action: $action, order: LAST_ACTION_DESC, limit: $limit, offset: $offset) {
        total
        products {
          ${PRODUCT_FIELDS}
          otherUserInfos(username: $username) { id }
        }
      }
    }
  }
`;

const LIST_INFO_QUERY = `
  query StremlistListInfo($id: Int!) {
    userList(id: $id) { id label isPrivate universe }
  }
`;

const LIST_QUERY = `
  query StremlistList($id: Int!, $limit: Int, $offset: Int) {
    userList(id: $id) {
      id
      isPrivate
      productsList(limit: $limit, offset: $offset, order: ASC, sortBy: BY_DEFAULT) {
        total
        items { product { ${PRODUCT_FIELDS} } }
      }
    }
  }
`;

const CHART_QUERY = `
  query StremlistChart($universe: String, $subtype: TopSubtype!, $limit: Int) {
    top(universe: $universe, subtype: $subtype, limit: $limit, offset: 0) {
      ${PRODUCT_FIELDS}
    }
  }
`;

const POLL_INFO_QUERY = `
  query StremlistPollInfo($id: Int!) {
    poll(id: $id) { id label universe }
  }
`;

const POLL_QUERY = `
  query StremlistPoll($id: Int!) {
    poll(id: $id) { id products { ${PRODUCT_FIELDS} } }
  }
`;

const userSchema = z.object({
  username: z.string(),
  settings: z.object({ privacyProfile: z.boolean().nullish() }).nullish(),
});

const userDataSchema = z.object({ user: userSchema.nullish() });

const collectionDataSchema = z.object({
  user: userSchema
    .extend({
      collection: z
        .object({
          total: z.number().nullish(),
          products: z.array(senscritiqueProductSchema).nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

const chartDataSchema = z.object({
  top: z.array(senscritiqueProductSchema).nullish(),
});

const pollInfoDataSchema = z.object({
  poll: z
    .object({
      id: z.number(),
      label: z.string().nullish(),
      universe: z.number().nullish(),
    })
    .nullish(),
});

const pollDataSchema = z.object({
  poll: z
    .object({ products: z.array(senscritiqueProductSchema).nullish() })
    .nullish(),
});

const listInfoDataSchema = z.object({
  userList: z
    .object({
      id: z.number().optional(),
      label: z.string().nullish(),
      isPrivate: z.boolean().nullish(),
      universe: z.number().nullish(),
    })
    .nullish(),
});

const listDataSchema = z.object({
  userList: z
    .object({
      id: z.number().optional(),
      isPrivate: z.boolean().nullish(),
      productsList: z
        .object({
          total: z.number().nullish(),
          items: z
            .array(z.object({ product: senscritiqueProductSchema.nullish() }))
            .nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

async function senscritiqueQuery<T>(
  query: string,
  variables: Record<string, unknown>,
  schema: z.ZodType<T>,
) {
  const send = () =>
    graphqlRequest(SENSCRITIQUE_GRAPHQL, query, variables, schema, {
      limiter: senscritiqueLimiter,
      timeoutMs: QUERY_TIMEOUT_MS,
    });
  const json = await send().catch((error: unknown) => {
    if (error instanceof Error && error.name === "TimeoutError") return send();
    throw error;
  });
  if (!json.data) {
    throw new Error(
      `SensCritique GraphQL error: ${json.errors?.[0]?.message ?? "no data"}`,
    );
  }
  return json.data;
}

function universeType(universe: number | null | undefined) {
  if (universe === UNIVERSE_MOVIE) return "movie";
  return universe === UNIVERSE_SERIES ? "series" : null;
}

function yearFromDate(date: string | null | undefined) {
  const year = Number(date?.slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : undefined;
}

function yearOf(product: SensCritiqueProduct) {
  return (
    yearFromDate(product.dateReleaseOriginal) ??
    yearFromDate(product.dateRelease) ??
    product.yearOfProduction ??
    undefined
  );
}

function names(people: z.infer<typeof personSchema>[] | null | undefined) {
  return (people ?? [])
    .map((person) => person.name?.trim())
    .filter((name): name is string => !!name);
}

function justwatchPath(product: SensCritiqueProduct) {
  for (const provider of product.providers ?? []) {
    const url = provider.justwatchUrl?.trim();
    if (!url) continue;
    const path = /^https?:\/\//i.test(url) ? new URL(url).pathname : url;
    if (path.startsWith("/")) return path;
  }
  return undefined;
}

/**
 * Turn a SensCritique product into a Source entry, or null for products that
 * are not movies or series.
 */
export function productToEntry(product: SensCritiqueProduct) {
  const type = universeType(product.universe);
  if (!type || !product.id) return null;
  const directors = names(product.directors);
  return {
    type,
    title: product.title ?? undefined,
    originalTitle: product.originalTitle ?? undefined,
    year: yearOf(product),
    directors:
      directors.length > 0 || type === "movie"
        ? directors
        : names(product.creators),
    runtimeMinutes: product.duration
      ? Math.round(product.duration / 60)
      : undefined,
    externalIds: {
      senscritique: product.id,
      justwatchPath: justwatchPath(product),
    },
  };
}

function mergeByActionId(a: SensCritiqueProduct[], b: SensCritiqueProduct[]) {
  const merged: SensCritiqueProduct[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const left = a[i].otherUserInfos?.id ?? Number.POSITIVE_INFINITY;
    const right = b[j].otherUserInfos?.id ?? Number.POSITIVE_INFINITY;
    merged.push(left <= right ? a[i++] : b[j++]);
  }
  return merged.concat(a.slice(i), b.slice(j));
}

function isPrivateProfile(user: z.infer<typeof userSchema> | null | undefined) {
  return user?.settings?.privacyProfile === true;
}

function nextPage(page: number, count: number, total: number) {
  return count < PAGE_SIZE || page * PAGE_SIZE + count >= total
    ? null
    : page + 1;
}

function fetchUniverseCollection(
  username: string,
  universe: Universe,
  action: CollectionAction,
) {
  return readPages({
    maxPages: MAX_PAGES,
    first: 0,
    async page(page) {
      const { user } = await senscritiqueQuery(
        COLLECTION_QUERY,
        {
          username,
          action,
          universe,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        },
        collectionDataSchema,
      );
      if (!user) {
        throw new SourceUnavailableError(
          "not_found",
          `SensCritique user ${username} not found`,
        );
      }
      if (isPrivateProfile(user) || !user.collection) {
        throw new SourceUnavailableError(
          "private",
          `SensCritique profile ${username} is private`,
        );
      }
      const batch = user.collection.products ?? [];
      return {
        items: batch,
        next: nextPage(page, batch.length, user.collection.total ?? 0),
      };
    },
  });
}

async function fetchCollection(
  username: string,
  collection: SensCritiqueCollection,
) {
  const reads = await Promise.all(
    collectionReads(collection).map(([universe, action]) =>
      fetchUniverseCollection(username, universe, action),
    ),
  );
  return {
    items: reads
      .map((read) => read.items.reverse())
      .reduce<SensCritiqueProduct[]>(mergeByActionId, []),
    complete: reads.every((read) => read.complete),
  };
}

async function fetchChart(chart: Chart) {
  const { top } = await senscritiqueQuery(
    CHART_QUERY,
    { ...chart, limit: CHART_LIMIT },
    chartDataSchema,
  );
  return { items: top ?? [], complete: true };
}

async function fetchPoll(id: number) {
  const { poll } = await senscritiqueQuery(POLL_QUERY, { id }, pollDataSchema);
  if (!poll) {
    throw new SourceUnavailableError(
      "not_found",
      `SensCritique poll ${id} not found`,
    );
  }
  return { items: poll.products ?? [], complete: true };
}

function fetchListProducts(id: number) {
  return readPages({
    maxPages: MAX_PAGES,
    first: 0,
    async page(page) {
      const { userList } = await senscritiqueQuery(
        LIST_QUERY,
        { id, limit: PAGE_SIZE, offset: page * PAGE_SIZE },
        listDataSchema,
      );
      if (!userList) {
        throw new SourceUnavailableError(
          "not_found",
          `SensCritique list ${id} not found`,
        );
      }
      if (userList.isPrivate || !userList.productsList) {
        throw new SourceUnavailableError(
          "private",
          `SensCritique list ${id} is private`,
        );
      }
      const items = userList.productsList.items ?? [];
      return {
        items: items.flatMap((item) => (item.product ? [item.product] : [])),
        next: nextPage(page, items.length, userList.productsList.total ?? 0),
      };
    },
  });
}

export const senscritiqueWikidataStrategy = wikidataStrategy(
  "wikidata-senscritique",
  WIKIDATA_SENSCRITIQUE_WORK,
  (entry) =>
    entry.externalIds?.senscritique === undefined
      ? undefined
      : String(entry.externalIds.senscritique),
);

/**
 * SensCritique: a user's collections of films and series ("Envies", "Vus",
 * "Notés", "Coups de cœur"), public lists, the public charts and the results
 * of polls, read anonymously. No Connection and no Actions: SensCritique has
 * no public API for them.
 */
export const senscritiqueProvider: ProviderAdapter = {
  id: "senscritique",
  freshnessMs: 6 * 60 * 60_000,

  async validateSource(ref) {
    const user = userRef(ref);
    if (user) {
      const [name, collection] = user;
      const data = await senscritiqueQuery(
        USER_QUERY,
        { username: name },
        userDataSchema,
      );
      if (!data.user) return { ok: false, reason: "not_found" };
      if (isPrivateProfile(data.user)) return { ok: false, reason: "private" };
      const username = data.user.username;
      const { noun } = SENSCRITIQUE_COLLECTIONS[collection];
      return {
        ok: true,
        ref: `users/${username}/${collection}`,
        suggestedTitle: `${username}'s ${noun}`,
        defaultDisplayMode: "split",
      };
    }

    const chart = CHARTS.get(ref);
    if (chart) {
      return {
        ok: true,
        ref,
        defaultDisplayMode: chart.universe === "movie" ? "movie" : "series",
      };
    }

    const pollMatch = POLL_REF.exec(ref);
    if (pollMatch) {
      const { poll } = await senscritiqueQuery(
        POLL_INFO_QUERY,
        { id: Number(pollMatch[1]) },
        pollInfoDataSchema,
      );
      if (!poll) return { ok: false, reason: "not_found" };
      const type = universeType(poll.universe);
      if (typeof poll.universe === "number" && !type) {
        return { ok: false, reason: "not_found" };
      }
      const label = poll.label?.trim();
      return {
        ok: true,
        ref: `polls/${poll.id}`,
        suggestedTitle: label === "" ? undefined : label,
        defaultDisplayMode: type ?? "split",
      };
    }

    const list = LIST_REF.exec(ref);
    if (list) {
      const { userList } = await senscritiqueQuery(
        LIST_INFO_QUERY,
        { id: Number(list[1]) },
        listInfoDataSchema,
      );
      if (!userList) return { ok: false, reason: "not_found" };
      if (userList.isPrivate) return { ok: false, reason: "private" };
      const type = universeType(userList.universe);
      if (typeof userList.universe === "number" && !type) {
        return { ok: false, reason: "not_found" };
      }
      const label = userList.label?.trim();
      return {
        ok: true,
        ref: `lists/${userList.id}`,
        suggestedTitle: label === "" ? undefined : label,
        defaultDisplayMode: type ?? "split",
      };
    }

    return { ok: false, reason: "not_found" };
  },

  async fetchSource(ref) {
    const user = userRef(ref);
    const list = LIST_REF.exec(ref);
    const chart = CHARTS.get(ref);
    const poll = POLL_REF.exec(ref);
    let read: PagedRead<SensCritiqueProduct>;
    if (user) {
      read = await fetchCollection(...user);
    } else if (list) {
      read = await fetchListProducts(Number(list[1]));
    } else if (chart) {
      read = await fetchChart(chart);
    } else if (poll) {
      read = await fetchPoll(Number(poll[1]));
    } else {
      throw new SourceUnavailableError(
        "not_found",
        `Unknown SensCritique source: ${ref}`,
      );
    }
    const entries: SourceEntry[] = [];
    const seen = new Set<number>();
    for (const product of read.items) {
      const entry = productToEntry(product);
      if (!entry || seen.has(product.id)) continue;
      seen.add(product.id);
      entries.push(entry);
    }
    return { entries, complete: read.complete };
  },

  resolutionKey(entry) {
    const id = entry.externalIds?.senscritique;
    return id === undefined
      ? null
      : { namespace: "senscritique", externalId: String(id) };
  },

  /**
   * Exact strategies first. Wikidata answers a whole batch in one request, so
   * it goes before the JustWatch lookups (one request per entry).
   */
  resolverStrategies: [
    senscritiqueWikidataStrategy,
    justwatchPathStrategy,
    tmdbSearchMatchStrategy,
  ],
};
