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
import type {
  PagedRead,
  ProviderAdapter,
  SourceEntry,
  SourceValidation,
} from "./types";
import { SourceUnavailableError } from "./types";

/**
 * SensCritique's unofficial GraphQL API, the one its website uses. There is
 * no public API: introspection is off, a CSRF check rejects requests that are
 * not JSON, and Cloudflare sits in front. Products carry no IMDb or TMDB ID,
 * so every entry goes through the ID resolver (ADR 0002).
 */
const SENSCRITIQUE_GRAPHQL = "https://apollo.senscritique.com/";
const senscritiqueLimiter = new RateLimiter(3, 1000);
/**
 * A page answers in under a second. Some requests stall until the timeout,
 * so a query waits less than the default and is sent again once.
 */
const QUERY_TIMEOUT_MS = 8_000;
const PAGE_SIZE = 100;
/** Stop after this many pages per universe (10,000 products). */
const MAX_PAGES = 100;

/** SensCritique universes: products of other universes (books, games…) are skipped. */
const UNIVERSE_MOVIE = 1;
const UNIVERSE_SERIES = 4;

/** Wikidata property "SensCritique work ID". */
const WIKIDATA_SENSCRITIQUE_WORK = "P10100";

/** `users/{user}/{collection}`, or `users/{user}/done/{year}` for one year. */
const USER_REF = /^users\/([\w.-]+)\/([a-z]+)(?:\/(\d{4}))?$/;
const LIST_REF = /^lists\/(\d+)$/;
const POLL_REF = /^polls\/(\d+)$/;

type Universe = "movie" | "tvShow";
type CollectionAction =
  (typeof SENSCRITIQUE_COLLECTIONS)[SensCritiqueCollection]["action"];

interface Chart {
  subtype: "TOP_111" | "TOP_100_OUT_OF_TOP_10" | "TOP_111_ANIME";
  universe: Universe;
}

/** The public charts, read with `top(universe, subtype)`. */
const CHARTS = new Map<string, Chart>([
  ["top111-movies", { subtype: "TOP_111", universe: "movie" }],
  ["top111-series", { subtype: "TOP_111", universe: "tvShow" }],
  ["top100-movies", { subtype: "TOP_100_OUT_OF_TOP_10", universe: "movie" }],
  ["top100-series", { subtype: "TOP_100_OUT_OF_TOP_10", universe: "tvShow" }],
  // The anime chart has only series: with "movie" it is empty.
  ["top111-anime", { subtype: "TOP_111_ANIME", universe: "tvShow" }],
]);
/** A chart has 100 to 150 products; one request reads it whole. */
const CHART_LIMIT = 200;

/**
 * The collection actions read per universe. A rated series is watched, but
 * the series DONE collection misses most of them (7 DONE against 167 rated
 * for one user), so "done" also reads the rated series. For films, DONE
 * already holds the rated ones.
 */
function collectionReads(
  collection: SensCritiqueCollection,
): [Universe, CollectionAction][] {
  const { action } = SENSCRITIQUE_COLLECTIONS[collection];
  const reads: [Universe, CollectionAction][] = [
    ["movie", action],
    ["tvShow", action],
  ];
  if (collection === "done") reads.push(["tvShow", "RATING"]);
  return reads;
}

interface UserRef {
  username: string;
  collection: SensCritiqueCollection;
  /** Only the titles that the user watched in this year. */
  year?: number;
}

/**
 * The parts of a `users/{user}/{collection}` reference. Only the watched
 * collection has a form for one year, `users/{user}/done/{year}`.
 */
function userRef(ref: string): UserRef | null {
  const match = USER_REF.exec(ref);
  if (!match || !isSensCritiqueCollection(match[2])) return null;
  const [, username, collection, year] = match;
  if (year === undefined) return { username, collection };
  return collection === "done"
    ? { username, collection, year: Number(year) }
    : null;
}

const personSchema = z.object({ name: z.string().nullish() });

const senscritiqueProductSchema = z.object({
  id: z.number(),
  title: z.string().nullish(),
  originalTitle: z.string().nullish(),
  /** Often the French release year, not the original one. */
  yearOfProduction: z.number().nullish(),
  /** Original release date, sometimes partial ("1966-07-00", "2011"). */
  dateReleaseOriginal: z.string().nullish(),
  dateRelease: z.string().nullish(),
  /** Seconds (per episode for series). */
  duration: z.number().nullish(),
  universe: z.number().nullish(),
  directors: z.array(personSchema).nullish(),
  creators: z.array(personSchema).nullish(),
  providers: z
    .array(z.object({ justwatchUrl: z.string().nullish() }))
    .nullish(),
  /** The user's row for this product; its ID grows with each new action. */
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

// LAST_ACTION_DESC is newest first, the order of the action row IDs that
// mergeByActionId relies on. A null yearDateDone reads all the years.
const COLLECTION_QUERY = `
  query StremlistCollection($username: String!, $action: ProductAction!, $universe: String, $yearDateDone: Int, $limit: Int, $offset: Int) {
    user(username: $username) {
      username
      settings { privacyProfile }
      collection(universe: $universe, action: $action, yearDateDone: $yearDateDone, order: LAST_ACTION_DESC, limit: $limit, offset: $offset) {
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

// BY_DEFAULT is the order that the list shows on SensCritique.
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

// Best ranked first.
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

// The results of a poll, best ranked first.
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
): Promise<T> {
  const send = () =>
    graphqlRequest(SENSCRITIQUE_GRAPHQL, query, variables, schema, {
      limiter: senscritiqueLimiter,
      timeoutMs: QUERY_TIMEOUT_MS,
    });
  // The queries only read, so sending one again is safe.
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

function universeType(
  universe: number | null | undefined,
): "movie" | "series" | null {
  if (universe === UNIVERSE_MOVIE) return "movie";
  return universe === UNIVERSE_SERIES ? "series" : null;
}

function yearFromDate(date: string | null | undefined): number | undefined {
  const year = Number(date?.slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : undefined;
}

/**
 * The original release year, which is what TMDB and IMDb use.
 * "yearOfProduction" is often the French release year of old films (Gaslight,
 * 1944, has 1947), so it only fills in when no date is known.
 */
function yearOf(product: SensCritiqueProduct): number | undefined {
  return (
    yearFromDate(product.dateReleaseOriginal) ??
    yearFromDate(product.dateRelease) ??
    product.yearOfProduction ??
    undefined
  );
}

function names(
  people: z.infer<typeof personSchema>[] | null | undefined,
): string[] {
  return (people ?? [])
    .map((person) => person.name?.trim())
    .filter((name): name is string => !!name);
}

function justwatchPath(product: SensCritiqueProduct): string | undefined {
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
export function productToEntry(
  product: SensCritiqueProduct,
): SourceEntry | null {
  const type = universeType(product.universe);
  if (!type || !product.id) return null;
  const directors = names(product.directors);
  return {
    type,
    title: product.title ?? undefined,
    originalTitle: product.originalTitle ?? undefined,
    year: yearOf(product),
    // Series rarely have a director on SensCritique; their creators play the
    // same role for the TMDB match (TMDB's "created_by").
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

/**
 * Merge two lists that are each oldest first, using the user's action row ID
 * as the clock. The collection API has no date, but these IDs grow over time.
 */
function mergeByActionId(
  a: SensCritiqueProduct[],
  b: SensCritiqueProduct[],
): SensCritiqueProduct[] {
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

function isPrivateProfile(
  user: z.infer<typeof userSchema> | null | undefined,
): boolean {
  return user?.settings?.privacyProfile === true;
}

/**
 * The next page number after `page`, or null when this page of `count`
 * items reached the end of a collection of `total`.
 */
function nextPage(page: number, count: number, total: number): number | null {
  return count < PAGE_SIZE || page * PAGE_SIZE + count >= total
    ? null
    : page + 1;
}

/** One collection of one universe, newest first, as the API returns it. */
function fetchUniverseCollection(
  { username, year }: UserRef,
  universe: Universe,
  action: CollectionAction,
): Promise<PagedRead<SensCritiqueProduct>> {
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
          yearDateDone: year ?? null,
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
  user: UserRef,
): Promise<PagedRead<SensCritiqueProduct>> {
  // The shared limiter keeps the reads under SensCritique's rate.
  const reads = await Promise.all(
    collectionReads(user.collection).map(([universe, action]) =>
      fetchUniverseCollection(user, universe, action),
    ),
  );
  // The API returns the newest action first; the canonical order is oldest
  // first. A series both done and rated comes twice with the same action
  // row, and fetchSource keeps it once.
  return {
    items: reads
      .map((read) => read.items.reverse())
      .reduce<SensCritiqueProduct[]>(mergeByActionId, []),
    complete: reads.every((read) => read.complete),
  };
}

async function fetchChart(
  chart: Chart,
): Promise<PagedRead<SensCritiqueProduct>> {
  const { top } = await senscritiqueQuery(
    CHART_QUERY,
    { ...chart, limit: CHART_LIMIT },
    chartDataSchema,
  );
  return { items: top ?? [], complete: true };
}

async function fetchPoll(id: number): Promise<PagedRead<SensCritiqueProduct>> {
  const { poll } = await senscritiqueQuery(POLL_QUERY, { id }, pollDataSchema);
  if (!poll) {
    throw new SourceUnavailableError(
      "not_found",
      `SensCritique poll ${id} not found`,
    );
  }
  return { items: poll.products ?? [], complete: true };
}

function fetchListProducts(
  id: number,
): Promise<PagedRead<SensCritiqueProduct>> {
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
 * also for one year, "Notés", "Coups de cœur", "En cours", "Il a récemment
 * aimé"), public lists (top 10s and poll rankings among them), the public
 * charts and the results of polls, read anonymously. No Connection and no Actions: SensCritique has
 * no public API for them.
 */
export const senscritiqueProvider: ProviderAdapter = {
  id: "senscritique",
  freshnessMs: 6 * 60 * 60_000,

  async validateSource(ref): Promise<SourceValidation> {
    const user = userRef(ref);
    if (user) {
      const { collection, year } = user;
      const data = await senscritiqueQuery(
        USER_QUERY,
        { username: user.username },
        userDataSchema,
      );
      if (!data.user) return { ok: false, reason: "not_found" };
      if (isPrivateProfile(data.user)) return { ok: false, reason: "private" };
      const username = data.user.username;
      const { noun } = SENSCRITIQUE_COLLECTIONS[collection];
      return {
        ok: true,
        ref:
          year === undefined
            ? `users/${username}/${collection}`
            : `users/${username}/${collection}/${year}`,
        suggestedTitle:
          year === undefined
            ? `${username}'s ${noun}`
            : `${username}'s ${noun} in ${year}`,
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
      // A poll of another universe has no movies or series.
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
      // A list of another universe has no movies or series.
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
      read = await fetchCollection(user);
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

  // Exact strategies first. Wikidata answers a whole batch in one request, so
  // it goes before the JustWatch lookups (one request per entry).
  resolverStrategies: [
    senscritiqueWikidataStrategy,
    justwatchPathStrategy,
    tmdbSearchMatchStrategy,
  ],
};
