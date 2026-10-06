import { parseSourceLink } from "@stremlist/shared/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No waiting between mocked requests.
vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof HttpModule>();
  class InstantLimiter {
    acquire(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { ...actual, RateLimiter: InstantLimiter };
});

import {
  candidateMatches,
  matchOnTmdb,
  samePerson,
} from "../../titles/tmdb-match";
import { wikidataImdbIds } from "../../titles/wikidata";
import type * as HttpModule from "../http";
import type { SensCritiqueProduct } from "../senscritique";
import {
  justwatchPathStrategy,
  productToEntry,
  senscritiqueProvider,
  senscritiqueWikidataStrategy,
} from "../senscritique";
import type { SourceEntry } from "../types";
import { SourceUnavailableError } from "../types";

const ctx = { connection: null };

interface RecordedRequest {
  url: string;
  body: string;
  /** Parsed GraphQL request, for SensCritique calls. */
  json: { query: string; variables: Record<string, unknown> };
}

let requests: RecordedRequest[] = [];
let handler: (request: RecordedRequest) => unknown;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      const request: RecordedRequest = {
        url,
        body,
        json: url.startsWith("https://apollo.senscritique.com")
          ? (JSON.parse(body) as RecordedRequest["json"])
          : { query: "", variables: {} },
      };
      requests.push(request);
      const result = handler(request);
      return Promise.resolve(
        result instanceof Response ? result : jsonResponse(result),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function product(
  id: number,
  overrides: Partial<SensCritiqueProduct> = {},
): SensCritiqueProduct {
  return {
    id,
    title: `Film ${id}`,
    originalTitle: null,
    yearOfProduction: 2000,
    dateRelease: "2000-01-01",
    duration: 6000,
    universe: 1,
    directors: [{ name: "Some Director" }],
    creators: [],
    providers: [],
    otherUserInfos: { id: id * 10 },
    ...overrides,
  };
}

function wishesPage(
  products: SensCritiqueProduct[],
  total: number,
  privacyProfile = false,
) {
  return {
    data: {
      user: {
        username: "Sergent_Pepper",
        settings: { privacyProfile },
        collection: { total, products },
      },
    },
  };
}

describe("SensCritique wishes", () => {
  it("pages through films and series, oldest wish first", async () => {
    // The API answers newest first. Films: action IDs 1050 (newest) … 50.
    const films = Array.from({ length: 101 }, (_, index) =>
      product(1000 - index, { otherUserInfos: { id: 1050 - index * 10 } }),
    );
    // A book that slipped into the collection must be skipped.
    films[3] = product(5, { universe: 2, otherUserInfos: { id: 1020 } });
    const series = [
      product(2001, { universe: 4, otherUserInfos: { id: 1055 } }),
      product(2002, { universe: 4, otherUserInfos: { id: 45 } }),
    ];
    handler = ({ json }) => {
      const { universe, offset } = json.variables as {
        universe: string;
        offset: number;
      };
      if (universe === "movie") {
        return wishesPage(films.slice(offset, offset + 100), films.length);
      }
      return wishesPage(series.slice(offset, offset + 100), series.length);
    };

    const { entries } = await senscritiqueProvider.fetchSource(
      "users/Sergent_Pepper/wishes",
      ctx,
    );

    expect(
      requests.map(({ json }) => [
        json.variables.universe,
        json.variables.offset,
        json.variables.limit,
      ]),
    ).toEqual([
      ["movie", 0, 100],
      ["movie", 100, 100],
      ["tvShow", 0, 100],
    ]);
    expect(requests[0].json.query).toContain("action: WISH");
    expect(entries).toHaveLength(102);
    const ids = entries.map((entry) => entry.externalIds?.senscritique);
    expect(ids[0]).toBe(2002);
    expect(ids[1]).toBe(900);
    expect(ids.at(-1)).toBe(2001);
    expect(ids.at(-2)).toBe(1000);
    expect(ids).not.toContain(5);
    expect(entries[0].type).toBe("series");
    expect(entries[1].type).toBe("movie");
  });

  it("reports an unknown user as not found", async () => {
    handler = () => ({ data: { user: null } });
    await expect(
      senscritiqueProvider.fetchSource("users/nobody/wishes", ctx),
    ).rejects.toMatchObject({ reason: "not_found" });
  });

  it("reports a private profile as private", async () => {
    handler = () => wishesPage([], 0, true);
    const error = await senscritiqueProvider
      .fetchSource("users/hidden/wishes", ctx)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceUnavailableError);
    expect(error).toMatchObject({ reason: "private" });
  });

  it("treats a Cloudflare block as unavailable, not as an expected state", async () => {
    handler = () => new Response("<html>blocked</html>", { status: 403 });
    const error = await senscritiqueProvider
      .fetchSource("users/Sergent_Pepper/wishes", ctx)
      .catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(SourceUnavailableError);
  });
});

describe("SensCritique lists", () => {
  it("pages through a list in its own order and keeps only films and series", async () => {
    const items = Array.from({ length: 130 }, (_, index) => ({
      product: product(index + 1, {
        universe: index === 10 ? 3 : index % 2 === 0 ? 1 : 4,
      }),
    }));
    handler = ({ json }) => {
      const { offset, limit } = json.variables as {
        offset: number;
        limit: number;
      };
      return {
        data: {
          userList: {
            id: 369869,
            isPrivate: false,
            productsList: {
              total: items.length,
              items: items.slice(offset, offset + limit),
            },
          },
        },
      };
    };

    const { entries } = await senscritiqueProvider.fetchSource(
      "lists/369869",
      ctx,
    );

    expect(requests.map(({ json }) => json.variables.offset)).toEqual([0, 100]);
    expect(requests[0].json.variables.id).toBe(369869);
    expect(entries).toHaveLength(129);
    expect(entries[0].externalIds?.senscritique).toBe(1);
    expect(entries.at(-1)?.externalIds?.senscritique).toBe(130);
    expect(
      entries.map((entry) => entry.externalIds?.senscritique),
    ).not.toContain(11);
  });

  it("reports an unknown list as not found", async () => {
    handler = () => ({ data: { userList: null } });
    await expect(
      senscritiqueProvider.fetchSource("lists/1", ctx),
    ).rejects.toMatchObject({ reason: "not_found" });
  });
});

describe("SensCritique validateSource", () => {
  it("normalizes the username and suggests a title", async () => {
    handler = () => ({
      data: {
        user: {
          username: "Sergent_Pepper",
          settings: { privacyProfile: false },
        },
      },
    });
    await expect(
      senscritiqueProvider.validateSource("users/sergent_pepper/wishes", ctx),
    ).resolves.toEqual({
      ok: true,
      ref: "users/Sergent_Pepper/wishes",
      suggestedTitle: "Sergent_Pepper's wishlist",
      defaultDisplayMode: "split",
    });
  });

  it("uses the list label and universe", async () => {
    handler = () => ({
      data: {
        userList: {
          id: 369869,
          label: "Les arcanes du blockbuster",
          isPrivate: false,
          universe: 1,
        },
      },
    });
    await expect(
      senscritiqueProvider.validateSource("lists/369869", ctx),
    ).resolves.toEqual({
      ok: true,
      ref: "lists/369869",
      suggestedTitle: "Les arcanes du blockbuster",
      defaultDisplayMode: "movie",
    });
  });

  it("rejects unknown users, private lists and book lists", async () => {
    handler = () => ({ data: { user: null } });
    await expect(
      senscritiqueProvider.validateSource("users/nobody/wishes", ctx),
    ).resolves.toMatchObject({ ok: false, reason: "not_found" });

    handler = () => ({
      data: { userList: { id: 2, label: "x", isPrivate: true, universe: 1 } },
    });
    await expect(
      senscritiqueProvider.validateSource("lists/2", ctx),
    ).resolves.toMatchObject({ ok: false, reason: "private" });

    handler = () => ({
      data: { userList: { id: 3, label: "x", isPrivate: false, universe: 2 } },
    });
    await expect(
      senscritiqueProvider.validateSource("lists/3", ctx),
    ).resolves.toMatchObject({ ok: false, reason: "not_found" });

    await expect(
      senscritiqueProvider.validateSource("nonsense", ctx),
    ).resolves.toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("productToEntry", () => {
  it("maps a film", () => {
    expect(
      productToEntry(
        product(469285, {
          title: "La Famille",
          originalTitle: "La Famiglia",
          yearOfProduction: 1987,
          dateRelease: "1987-08-19",
          duration: 7620,
          directors: [{ name: "Ettore Scola" }],
          providers: [
            { justwatchUrl: null },
            { justwatchUrl: "https://www.justwatch.com/fr/film/la-famille" },
          ],
        }),
      ),
    ).toEqual({
      type: "movie",
      title: "La Famille",
      originalTitle: "La Famiglia",
      year: 1987,
      directors: ["Ettore Scola"],
      runtimeMinutes: 127,
      externalIds: {
        senscritique: 469285,
        justwatchPath: "/fr/film/la-famille",
      },
    });
  });

  it("maps a series, with its creators and the release year", () => {
    expect(
      productToEntry(
        product(149118, {
          title: "Generation Kill",
          universe: 4,
          yearOfProduction: null,
          dateRelease: "2008-11-18",
          duration: 4080,
          directors: [],
          creators: [{ name: "David Simon" }, { name: "Ed Burns" }],
          providers: [{ justwatchUrl: "/fr/serie/generation-kill" }],
        }),
      ),
    ).toMatchObject({
      type: "series",
      year: 2008,
      directors: ["David Simon", "Ed Burns"],
      runtimeMinutes: 68,
      externalIds: {
        senscritique: 149118,
        justwatchPath: "/fr/serie/generation-kill",
      },
    });
  });

  it("uses the original release year, not the French one", () => {
    expect(
      productToEntry(
        product(464483, {
          title: "Hantise",
          yearOfProduction: 1947,
          dateReleaseOriginal: "1944-05-04",
          dateRelease: "1944-05-04",
        }),
      )?.year,
    ).toBe(1944);
    expect(
      productToEntry(
        product(1, {
          yearOfProduction: null,
          dateReleaseOriginal: "1966-07-00",
          dateRelease: null,
        }),
      )?.year,
    ).toBe(1966);
  });

  it("skips books, games and music", () => {
    expect(productToEntry(product(1, { universe: 2 }))).toBeNull();
    expect(productToEntry(product(1, { universe: 3 }))).toBeNull();
  });

  it("gives the resolver a SensCritique key", () => {
    expect(
      senscritiqueProvider.resolutionKey?.({
        externalIds: { senscritique: 42 },
      }),
    ).toEqual({ namespace: "senscritique", externalId: "42" });
    expect(senscritiqueProvider.resolutionKey?.({})).toBeNull();
  });
});

describe("JustWatch path strategy", () => {
  it("resolves entries that carry a JustWatch path", async () => {
    handler = ({ url, body }) => {
      expect(url).toBe("https://apis.justwatch.com/graphql");
      const { variables } = JSON.parse(body) as {
        variables: { path: string };
      };
      return {
        data: {
          urlV2:
            variables.path === "/fr/film/pacific-rim"
              ? { node: { content: { externalIds: { imdbId: "tt1663662" } } } }
              : null,
        },
      };
    };
    const found = await justwatchPathStrategy.resolve([
      { externalIds: { justwatchPath: "/fr/film/unknown" } },
      { externalIds: { senscritique: 1 } },
      { externalIds: { justwatchPath: "/fr/film/pacific-rim" } },
    ]);
    expect([...found]).toEqual([[2, "tt1663662"]]);
    expect(requests).toHaveLength(2);
  });
});

describe("Wikidata strategy", () => {
  it("looks up a whole batch in one SPARQL query", async () => {
    handler = ({ url, body }) => {
      expect(url).toBe("https://query.wikidata.org/sparql");
      const query = new URLSearchParams(body).get("query") ?? "";
      expect(query).toContain("wdt:P10100");
      expect(query).toContain('VALUES ?external { "473747" "10" "20" }');
      return {
        results: {
          bindings: [
            { external: { value: "473747" }, imdb: { value: "tt1663662" } },
            // Two different Titles for one ID: ambiguous, left out.
            { external: { value: "20" }, imdb: { value: "tt0000001" } },
            { external: { value: "20" }, imdb: { value: "tt0000002" } },
            // Not a Title ID.
            { external: { value: "10" }, imdb: { value: "nm0000001" } },
          ],
        },
      };
    };
    const found = await senscritiqueWikidataStrategy.resolve([
      { externalIds: { senscritique: 473747 } },
      { externalIds: { senscritique: 10 } },
      {},
      { externalIds: { senscritique: 20 } },
    ]);
    expect([...found]).toEqual([[0, "tt1663662"]]);
    expect(requests).toHaveLength(1);
  });

  it("splits large batches", async () => {
    handler = () => ({ results: { bindings: [] } });
    const ids = Array.from({ length: 450 }, (_, index) => String(index));
    await wikidataImdbIds("P10100", ids);
    expect(requests).toHaveLength(3);
  });
});

describe("TMDB search match", () => {
  const pacificRim: SourceEntry = {
    type: "movie",
    title: "Pacific Rim",
    year: 2013,
    directors: ["Guillermo del Toro"],
    runtimeMinutes: 131,
    externalIds: { senscritique: 473747 },
  };

  function tmdbHandler(movie: {
    imdbId: string;
    year: string;
    runtime: number;
    director: string;
    title?: string;
  }) {
    return ({ url }: RecordedRequest) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/3/search/movie") {
        expect(parsed.searchParams.get("language")).toBe("fr-FR");
        return {
          results: [
            // Wrong year: never checked.
            { id: 1, title: "Pacific Rim", release_date: "1990-01-01" },
            {
              id: 68726,
              title: movie.title ?? "Pacific Rim",
              original_title: movie.title ?? "Pacific Rim",
              release_date: `${movie.year}-07-11`,
            },
          ],
        };
      }
      if (parsed.pathname === "/3/movie/68726") {
        expect(parsed.searchParams.get("append_to_response")).toBe("credits");
        return {
          imdb_id: movie.imdbId,
          runtime: movie.runtime,
          credits: {
            crew: [
              { name: "Someone Else", job: "Producer" },
              { name: movie.director, job: "Director" },
            ],
          },
        };
      }
      throw new Error(`Unexpected request ${url}`);
    };
  }

  beforeEach(() => {
    vi.stubEnv("TMDB_READ_ACCESS_TOKEN", "test-token");
    vi.stubEnv("TMDB_API_KEY", "");
  });

  it("accepts the candidate when the director agrees", async () => {
    handler = tmdbHandler({
      imdbId: "tt1663662",
      year: "2014",
      runtime: 90,
      director: "Guillermo Del Toro",
    });
    await expect(matchOnTmdb(pacificRim)).resolves.toBe("tt1663662");
    expect(requests.some(({ url }) => url.includes("/movie/1?"))).toBe(false);
  });

  it("rejects the candidate when the director disagrees, even if the runtime agrees", async () => {
    handler = tmdbHandler({
      imdbId: "tt9999999",
      year: "2013",
      runtime: 131,
      director: "Michael Bay",
    });
    await expect(matchOnTmdb(pacificRim)).resolves.toBeNull();
  });

  it("accepts on runtime and exact title when the director is unknown", async () => {
    handler = tmdbHandler({
      imdbId: "tt1663662",
      year: "2013",
      runtime: 125,
      director: "Guillermo del Toro",
    });
    await expect(matchOnTmdb({ ...pacificRim, directors: [] })).resolves.toBe(
      "tt1663662",
    );
  });

  it("rejects on a runtime mismatch when the director is unknown", async () => {
    handler = tmdbHandler({
      imdbId: "tt1663662",
      year: "2013",
      runtime: 95,
      director: "Guillermo del Toro",
    });
    await expect(
      matchOnTmdb({ ...pacificRim, directors: [] }),
    ).resolves.toBeNull();
  });

  it("rejects runtime-only matches whose title differs", () => {
    expect(
      candidateMatches(
        { ...pacificRim, directors: [] },
        {
          titles: ["Pacific Rim: Uprising"],
          people: [],
          runtimes: [131],
          yearGap: 0,
        },
      ),
    ).toBe(false);
  });

  it.each([
    ["Lee Sang-Il", "Sang-il Lee"],
    ["Pernilla August (Pernilla Östergren)", "Pernilla August"],
    ["Guillermo del Toro", "Guillermo Del Toro"],
  ])("treats %s and %s as the same person", (a, b) => {
    expect(samePerson(a, b)).toBe(true);
  });

  it.each([
    ["Joel Coen", "Ethan Coen"],
    ["Tony Scott", "Ridley Scott"],
  ])("tells %s and %s apart", (a, b) => {
    expect(samePerson(a, b)).toBe(false);
  });

  it("tolerates transliterated director names", () => {
    expect(
      candidateMatches(
        { ...pacificRim, directors: ["Andreï Tarkovski"] },
        {
          titles: [],
          people: ["Andrei Tarkovsky"],
          runtimes: [],
          yearGap: 0,
        },
      ),
    ).toBe(true);
  });
});

describe("TMDB search match: years", () => {
  beforeEach(() => {
    vi.stubEnv("TMDB_READ_ACCESS_TOKEN", "test-token");
  });

  it("prefers the closest year among candidates by the same director", async () => {
    handler = ({ url }) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/3/search/movie") {
        return {
          results: [
            { id: 2, title: "Police Story 2", release_date: "1988-01-01" },
            { id: 3, title: "Police Story 3", release_date: "1986-06-01" },
            { id: 1, title: "Police Story", release_date: "1985-12-14" },
          ],
        };
      }
      const id = parsed.pathname.split("/").at(-1);
      return {
        imdb_id: `tt000000${id}`,
        runtime: 100,
        credits: { crew: [{ name: "Jackie Chan", job: "Director" }] },
      };
    };
    await expect(
      matchOnTmdb({
        type: "movie",
        title: "Police Story",
        year: 1985,
        directors: ["Jackie Chan"],
      }),
    ).resolves.toBe("tt0000001");
    // Police Story 2 (three years later) is never even loaded.
    expect(requests.some(({ url }) => url.includes("/movie/2?"))).toBe(false);
  });

  it("searches again within the year when the first page has no candidate", async () => {
    handler = ({ url }) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/3/search/movie") {
        return parsed.searchParams.get("year") === "1948"
          ? {
              results: [{ id: 7, title: "Escape", release_date: "1948-03-01" }],
            }
          : {
              results: [{ id: 8, title: "Escape", release_date: "2012-01-01" }],
            };
      }
      return {
        imdb_id: "tt0040330",
        runtime: 78,
        credits: { crew: [{ name: "Joseph L. Mankiewicz", job: "Director" }] },
      };
    };
    await expect(
      matchOnTmdb({
        type: "movie",
        title: "Escape",
        year: 1948,
        directors: ["Joseph L. Mankiewicz"],
      }),
    ).resolves.toBe("tt0040330");
  });

  it("accepts an earlier first air date for a series when the creator agrees", async () => {
    handler = ({ url }) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/3/search/tv") {
        return {
          results: [
            {
              id: 8592,
              name: "Parks and Recreation",
              first_air_date: "2009-04-09",
            },
          ],
        };
      }
      expect(parsed.searchParams.get("append_to_response")).toBe(
        "external_ids",
      );
      return {
        episode_run_time: [22],
        created_by: [{ name: "Greg Daniels" }, { name: "Michael Schur" }],
        external_ids: { imdb_id: "tt1266020" },
      };
    };
    const series: SourceEntry = {
      type: "series",
      title: "Parks and Recreation",
      year: 2015,
      directors: ["Michael Schur"],
      runtimeMinutes: 25,
    };
    await expect(matchOnTmdb(series)).resolves.toBe("tt1266020");
    // Without a creator, the runtime alone does not cover such a year gap.
    await expect(matchOnTmdb({ ...series, directors: [] })).resolves.toBeNull();
  });
});

describe("parseSourceLink for SensCritique", () => {
  it.each([
    [
      "https://www.senscritique.com/Sergent_Pepper",
      "users/Sergent_Pepper/wishes",
    ],
    [
      "https://www.senscritique.com/Sergent_Pepper/collection?action=WISH&universe=1",
      "users/Sergent_Pepper/wishes",
    ],
    ["senscritique.com/Sergent_Pepper/listes", "users/Sergent_Pepper/wishes"],
    [
      "https://www.senscritique.com/liste/les_arcanes_du_blockbuster/369869",
      "lists/369869",
    ],
  ])("parses %s", (link, ref) => {
    expect(parseSourceLink(link)).toMatchObject({
      provider: "senscritique",
      ref,
      requiresConnection: false,
    });
  });

  it("marks wishes as a watchlist with a title", () => {
    expect(
      parseSourceLink("https://www.senscritique.com/Sergent_Pepper"),
    ).toMatchObject({
      kind: "watchlist",
      suggestedTitle: "Sergent_Pepper's wishlist",
    });
    expect(
      parseSourceLink("https://www.senscritique.com/liste/x/369869"),
    ).toMatchObject({ kind: "list" });
  });

  it.each([
    "https://www.senscritique.com/film/pacific_rim/473747",
    "https://www.senscritique.com/serie/generation_kill/149118",
    "https://www.senscritique.com/films",
    "https://www.senscritique.com/liste/no-id",
    "https://www.senscritique.com/Sergent_Pepper/collection?action=DONE",
    "https://www.senscritique.com/",
  ])("does not parse %s as a SensCritique Source list", (link) => {
    expect(parseSourceLink(link)?.provider === "senscritique").toBe(false);
  });
});
