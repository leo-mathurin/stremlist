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
const PAGE_SIZE = 100;
/** Stop after this many pages per universe (10,000 products). */
const MAX_PAGES = 100;

/** SensCritique universes: products of other universes (books, games…) are skipped. */
const UNIVERSE_MOVIE = 1;
const UNIVERSE_SERIES = 4;

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
  const json = await graphqlRequest<T>(SENSCRITIQUE_GRAPHQL, query, variables, {
    limiter: senscritiqueLimiter,
  });
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

/**
 * The next page number after `page`, or null when this page of `count`
 * items reached the end of a collection of `total`.
 */
function nextPage(page: number, count: number, total: number): number | null {
  return count < PAGE_SIZE || page * PAGE_SIZE + count >= total
    ? null
    : page + 1;
}

/** The wishes of one universe, newest first, as the API returns them. */
function fetchUniverseWishes(
  username: string,
  universe: "movie" | "tvShow",
): Promise<PagedRead<SensCritiqueProduct>> {
  return readPages({
    maxPages: MAX_PAGES,
    first: 0,
    async page(page) {
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
      return {
        items: batch,
        next: nextPage(page, batch.length, user.collection.total ?? 0),
      };
    },
  });
}

async function fetchWishes(
  username: string,
): Promise<PagedRead<SensCritiqueProduct>> {
  // The shared limiter keeps both reads under SensCritique's rate.
  const [movies, shows] = await Promise.all([
    fetchUniverseWishes(username, "movie"),
    fetchUniverseWishes(username, "tvShow"),
  ]);
  // The API returns the newest wish first; the canonical order is oldest first.
  return {
    items: mergeByActionId(movies.items.reverse(), shows.items.reverse()),
    complete: movies.complete && shows.complete,
  };
}

function fetchListProducts(
  id: number,
): Promise<PagedRead<SensCritiqueProduct>> {
  return readPages({
    maxPages: MAX_PAGES,
    first: 0,
    async page(page) {
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
        // The list has no movies or series.
        return { ok: false, reason: "not_found" };
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
    let read: PagedRead<SensCritiqueProduct>;
    if (user) {
      read = await fetchWishes(user[1]);
    } else if (list) {
      read = await fetchListProducts(Number(list[1]));
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
