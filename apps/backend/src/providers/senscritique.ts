import { justwatchImdbIdByPath } from "../titles/justwatch-lookup";
import { mapWithConcurrency } from "../titles/tmdb";
import { tmdbSearchMatchStrategy } from "../titles/tmdb-match";
import { wikidataStrategy } from "../titles/wikidata";
import { HttpError, providerFetch, RateLimiter } from "./http";
import type {
  ProviderAdapter,
  ResolverStrategy,
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
const PAGE_SIZE = 100;
/** Stop after this many pages per universe (10,000 products). */
const MAX_PAGES = 100;
const JUSTWATCH_CONCURRENCY = 3;

/** SensCritique universes: products of other universes (books, games…) are skipped. */
const UNIVERSE_MOVIE = 1;
const UNIVERSE_SERIES = 4;
const COLLECTION_UNIVERSES = ["movie", "tvShow"] as const;

/** Wikidata property "SensCritique work ID". */
const WIKIDATA_SENSCRITIQUE_WORK = "P10100";

const USER_REF = /^users\/([\w.-]+)\/wishes$/;
const LIST_REF = /^lists\/(\d+)$/;

interface Person {
  name?: string | null;
}

export interface SensCritiqueProduct {
  id: number;
  title?: string | null;
  originalTitle?: string | null;
  /** Often the French release year, not the original one. */
  yearOfProduction?: number | null;
  /** Original release date, sometimes partial ("1966-07-00", "2011"). */
  dateReleaseOriginal?: string | null;
  dateRelease?: string | null;
  /** Seconds (per episode for series). */
  duration?: number | null;
  universe?: number | null;
  directors?: Person[] | null;
  creators?: Person[] | null;
  providers?: { justwatchUrl?: string | null }[] | null;
  /** The user's row for this product; its ID grows with each new action. */
  otherUserInfos?: { id?: number | null } | null;
}

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: { message: string }[];
}

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

// LAST_ACTION_DESC is the only order the collection accepts: newest first.
const WISHES_QUERY = `
  query StremlistWishes($username: String!, $universe: String, $limit: Int, $offset: Int) {
    user(username: $username) {
      username
      settings { privacyProfile }
      collection(universe: $universe, action: WISH, order: LAST_ACTION_DESC, limit: $limit, offset: $offset) {
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

interface UserData {
  user: {
    username: string;
    settings?: { privacyProfile?: boolean | null } | null;
  } | null;
}

interface WishesData {
  user:
    | (UserData["user"] & {
        collection?: {
          total?: number | null;
          products?: SensCritiqueProduct[] | null;
        } | null;
      })
    | null;
}

interface ListInfoData {
  userList: {
    id: number;
    label?: string | null;
    isPrivate?: boolean | null;
    universe?: number | null;
  } | null;
}

interface ListData {
  userList: {
    id: number;
    isPrivate?: boolean | null;
    productsList?: {
      total?: number | null;
      items?: { product?: SensCritiqueProduct | null }[] | null;
    } | null;
  } | null;
}

async function senscritiqueQuery<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await providerFetch(SENSCRITIQUE_GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
    limiter: senscritiqueLimiter,
  });
  if (!response.ok) {
    throw new HttpError(
      response.status,
      await response.text(),
      SENSCRITIQUE_GRAPHQL,
    );
  }
  const json = (await response.json()) as GraphQLResponse<T>;
  if (!json.data) {
    throw new Error(
      `SensCritique GraphQL error: ${json.errors?.[0]?.message ?? "no data"}`,
    );
  }
  return json.data;
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

function names(people: Person[] | null | undefined): string[] {
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
  const type =
    product.universe === UNIVERSE_MOVIE
      ? "movie"
      : product.universe === UNIVERSE_SERIES
        ? "series"
        : null;
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

function isPrivateProfile(user: UserData["user"]): boolean {
  return user?.settings?.privacyProfile === true;
}

async function fetchWishes(username: string): Promise<SensCritiqueProduct[]> {
  const byUniverse: SensCritiqueProduct[][] = [];
  for (const universe of COLLECTION_UNIVERSES) {
    const products: SensCritiqueProduct[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const { user } = await senscritiqueQuery<WishesData>(WISHES_QUERY, {
        username,
        universe,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
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
      products.push(...batch);
      if (
        batch.length < PAGE_SIZE ||
        products.length >= (user.collection.total ?? 0)
      ) {
        break;
      }
    }
    // The API returns the newest wish first; the canonical order is oldest first.
    byUniverse.push(products.reverse());
  }
  return mergeByActionId(byUniverse[0], byUniverse[1]);
}

async function fetchListProducts(id: number): Promise<SensCritiqueProduct[]> {
  const products: SensCritiqueProduct[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { userList } = await senscritiqueQuery<ListData>(LIST_QUERY, {
      id,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    });
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
    for (const item of items) {
      if (item.product) products.push(item.product);
    }
    if (
      items.length < PAGE_SIZE ||
      page * PAGE_SIZE + items.length >= (userList.productsList.total ?? 0)
    ) {
      break;
    }
  }
  return products;
}

/**
 * Exact resolution through the JustWatch link that SensCritique shows on
 * products available to stream in France.
 */
export const justwatchPathStrategy: ResolverStrategy = {
  name: "justwatch-path",
  async resolve(entries) {
    const found = new Map<number, string>();
    await mapWithConcurrency(
      entries,
      JUSTWATCH_CONCURRENCY,
      async (entry, index) => {
        const path = entry.externalIds?.justwatchPath;
        if (!path) return;
        try {
          const imdbId = await justwatchImdbIdByPath(path);
          if (imdbId) found.set(index, imdbId);
        } catch (error) {
          console.warn(
            `JustWatch lookup failed for ${path}:`,
            error instanceof Error ? error.message : error,
          );
        }
      },
    );
    return found;
  },
};

export const senscritiqueWikidataStrategy = wikidataStrategy(
  "wikidata-senscritique",
  WIKIDATA_SENSCRITIQUE_WORK,
  (entry) =>
    entry.externalIds?.senscritique === undefined
      ? undefined
      : String(entry.externalIds.senscritique),
);

/**
 * SensCritique: a user's wishes (films and series, "Envies") and public
 * lists, read anonymously. No Connection and no Actions: SensCritique has no
 * public API for them.
 */
export const senscritiqueProvider: ProviderAdapter = {
  id: "senscritique",
  freshnessMs: 6 * 60 * 60_000,

  async validateSource(ref): Promise<SourceValidation> {
    const user = USER_REF.exec(ref);
    if (user) {
      const data = await senscritiqueQuery<UserData>(USER_QUERY, {
        username: user[1],
      });
      if (!data.user) return { ok: false, reason: "not_found" };
      if (isPrivateProfile(data.user)) return { ok: false, reason: "private" };
      const username = data.user.username;
      return {
        ok: true,
        ref: `users/${username}/wishes`,
        suggestedTitle: `${username}'s wishlist`,
        defaultDisplayMode: "split",
      };
    }

    const list = LIST_REF.exec(ref);
    if (list) {
      const { userList } = await senscritiqueQuery<ListInfoData>(
        LIST_INFO_QUERY,
        { id: Number(list[1]) },
      );
      if (!userList) return { ok: false, reason: "not_found" };
      if (userList.isPrivate) return { ok: false, reason: "private" };
      if (
        typeof userList.universe === "number" &&
        userList.universe !== UNIVERSE_MOVIE &&
        userList.universe !== UNIVERSE_SERIES
      ) {
        return {
          ok: false,
          reason: "not_found",
          message: "This SensCritique list has no movies or series.",
        };
      }
      const label = userList.label?.trim();
      return {
        ok: true,
        ref: `lists/${userList.id}`,
        suggestedTitle: label === "" ? undefined : label,
        defaultDisplayMode:
          userList.universe === UNIVERSE_MOVIE
            ? "movie"
            : userList.universe === UNIVERSE_SERIES
              ? "series"
              : "split",
      };
    }

    return { ok: false, reason: "not_found" };
  },

  async fetchSource(ref) {
    const user = USER_REF.exec(ref);
    const list = LIST_REF.exec(ref);
    let products: SensCritiqueProduct[];
    if (user) {
      products = await fetchWishes(user[1]);
    } else if (list) {
      products = await fetchListProducts(Number(list[1]));
    } else {
      throw new SourceUnavailableError(
        "not_found",
        `Unknown SensCritique source: ${ref}`,
      );
    }
    const entries: SourceEntry[] = [];
    const seen = new Set<number>();
    for (const product of products) {
      const entry = productToEntry(product);
      if (!entry || seen.has(product.id)) continue;
      seen.add(product.id);
      entries.push(entry);
    }
    return { entries };
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
