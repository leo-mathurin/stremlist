import { parseSourceLink } from "@stremlist/shared/providers";
import { http } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { z } from "zod";
import { FakeJustWatch } from "../../test/helpers/justwatch.test-utils";
import { useMswServer } from "../../test/helpers/msw.test-utils";
import { justwatchPathStrategy } from "../../titles/justwatch-lookup";
import {
  candidateMatches,
  matchOnTmdb,
  samePerson,
} from "../../titles/tmdb-match";
import { wikidataImdbIds } from "../../titles/wikidata";
import type { SensCritiqueProduct } from "../senscritique";
import {
  productToEntry,
  senscritiqueProvider,
  senscritiqueWikidataStrategy,
} from "../senscritique";
import type { SourceEntry } from "../types";
import { SourceUnavailableError } from "../types";

import { onFakeClock } from "../../test/helpers/clock.test-utils";
import { useFreshLimiters } from "./oauth-harness";

const server = useMswServer();

const ctx = { connection: null };

function timedOut() {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(
          new DOMException("The operation timed out.", "TimeoutError"),
        );
      },
    }),
  );
}

const graphQLRequest = z.object({
  query: z.string(),
  variables: z.record(z.string(), z.unknown()),
});

interface RecordedRequest {
  url: string;
  body: string;
  json: z.infer<typeof graphQLRequest>;
}

let requests: RecordedRequest[] = [];
let handlerErrors: unknown[] = [];
let handler: (request: RecordedRequest) => unknown;

beforeEach(() => {
  useFreshLimiters();
  requests = [];
  handlerErrors = [];
  server.use(
    http.all(/^https:\/\//, async ({ request: sent }) => {
      const url = sent.url;
      const body = await sent.text();
      const request: RecordedRequest = {
        url,
        body,
        json: url.startsWith("https://apollo.senscritique.com")
          ? graphQLRequest.parse(JSON.parse(body))
          : { query: "", variables: {} },
      };
      requests.push(request);
      try {
        const result = handler(request);
        return result instanceof Response ? result : Response.json(result);
      } catch (error) {
        handlerErrors.push(error);
        return new Response("The test handler failed", { status: 599 });
      }
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (handlerErrors.length > 0) {
    throw new AggregateError(handlerErrors, "A test handler failed");
  }
});

function product(id: number, overrides: Partial<SensCritiqueProduct> = {}) {
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

function listPage(products: SensCritiqueProduct[], total: number) {
  return {
    data: {
      userList: {
        isPrivate: false,
        productsList: { total, items: products.map((p) => ({ product: p })) },
      },
    },
  };
}

const pageVariablesSchema = z.object({
  universe: z.string().optional(),
  action: z.string().optional(),
  yearDateDone: z.number().nullish(),
  offset: z.number(),
  limit: z.number(),
});

function pageVariables({ json }: RecordedRequest) {
  return pageVariablesSchema.parse(json.variables);
}

describe("SensCritique fetchSource", () => {
  it("pages through films and series, oldest wish first", async () => {
    const films = Array.from({ length: 101 }, (_, index) =>
      product(1000 - index, { otherUserInfos: { id: 1050 - index * 10 } }),
    );
    films[3] = product(5, { universe: 2, otherUserInfos: { id: 1020 } });
    const series = [
      product(2001, { universe: 4, otherUserInfos: { id: 1055 } }),
      product(2002, { universe: 4, otherUserInfos: { id: 45 } }),
    ];
    handler = (request) => {
      const { universe, offset } = pageVariables(request);
      const products = universe === "movie" ? films : series;
      return wishesPage(products.slice(offset, offset + 100), products.length);
    };

    const { entries, complete } = await senscritiqueProvider.fetchSource(
      "users/Sergent_Pepper/wishes",
      ctx,
    );

    expect(complete).toBe(true);
    const pages = requests.map((request) => {
      const { universe, offset, limit } = pageVariables(request);
      return [universe, offset, limit];
    });
    expect(pages).toHaveLength(3);
    expect(pages).toEqual(
      expect.arrayContaining([
        ["movie", 0, 100],
        ["movie", 100, 100],
        ["tvShow", 0, 100],
      ]),
    );
    expect(requests.map((request) => pageVariables(request).action)).toEqual([
      "WISH",
      "WISH",
      "WISH",
    ]);
    expect(entries).toHaveLength(102);
    const ids = entries.map((entry) => entry.externalIds?.senscritique);
    expect([ids[0], ids[1], ids.at(-2), ids.at(-1)]).toEqual([
      2002, 900, 1000, 2001,
    ]);
    expect(ids).not.toContain(5);
    expect(entries[0].type).toBe("series");
    expect(entries[1].type).toBe("movie");
  });

  it.each([
    ["rated", "RATING"],
    ["recommend", "RECOMMEND"],
    ["current", "CURRENT"],
    ["liked", "RECENT"],
  ])("reads the %s collection of films and series", async (name, action) => {
    handler = (request) => {
      const { universe } = pageVariables(request);
      return wishesPage(
        [product(universe === "movie" ? 1 : 2, { universe: 1 })],
        1,
      );
    };

    const { entries } = await senscritiqueProvider.fetchSource(
      `users/Sergent_Pepper/${name}`,
      ctx,
    );

    expect(
      requests.map((request) => {
        const variables = pageVariables(request);
        return [variables.action, variables.universe];
      }),
    ).toEqual([
      [action, "movie"],
      [action, "tvShow"],
    ]);
    expect(entries).toHaveLength(2);
  });

  it("reads the done films, and the done and rated series", async () => {
    const both = product(30, { universe: 4, otherUserInfos: { id: 300 } });
    const reads = new Map([
      ["DONE movie", [product(10, { otherUserInfos: { id: 500 } })]],
      ["DONE tvShow", [both]],
      [
        "RATING tvShow",
        [product(40, { universe: 4, otherUserInfos: { id: 400 } }), both],
      ],
    ]);
    handler = (request) => {
      const { action, universe } = pageVariables(request);
      const products = reads.get(`${action} ${universe}`) ?? [];
      return wishesPage(products, products.length);
    };

    const { entries, complete } = await senscritiqueProvider.fetchSource(
      "users/Sergent_Pepper/done",
      ctx,
    );

    expect(complete).toBe(true);
    expect(requests).toHaveLength(3);
    expect(entries.map((entry) => entry.externalIds?.senscritique)).toEqual([
      30, 40, 10,
    ]);
  });

  it("reads the done films and series of one year", async () => {
    handler = (request) => {
      const { action, universe } = pageVariables(request);
      const products =
        action === "DONE" && universe === "movie" ? [product(10)] : [];
      return wishesPage(products, products.length);
    };

    const { entries } = await senscritiqueProvider.fetchSource(
      "users/Sergent_Pepper/done/2024",
      ctx,
    );

    expect(
      requests.map((request) => {
        const { action, universe, yearDateDone } = pageVariables(request);
        return [action, universe, yearDateDone];
      }),
    ).toEqual([
      ["DONE", "movie", 2024],
      ["DONE", "tvShow", 2024],
      ["RATING", "tvShow", 2024],
    ]);
    expect(entries.map((entry) => entry.externalIds?.senscritique)).toEqual([
      10,
    ]);
  });

  it("reads all the years when the reference has no year", async () => {
    handler = () => wishesPage([], 0);

    await senscritiqueProvider.fetchSource("users/Sergent_Pepper/done", ctx);

    expect(
      requests.map((request) => pageVariables(request).yearDateDone),
    ).toEqual([null, null, null]);
  });

  it("reads the anime chart from the series universe", async () => {
    handler = () => ({ data: { top: [product(3, { universe: 4 })] } });

    const { entries } = await senscritiqueProvider.fetchSource(
      "top111-anime",
      ctx,
    );

    expect(requests[0].json.variables).toMatchObject({
      subtype: "TOP_111_ANIME",
      universe: "tvShow",
    });
    expect(entries).toHaveLength(1);
  });

  it("reads a chart in its rank order", async () => {
    handler = () => ({
      data: {
        top: [
          product(3, { universe: 4 }),
          product(1, { universe: 4 }),
          product(2, { universe: 4 }),
        ],
      },
    });

    const { entries, complete } = await senscritiqueProvider.fetchSource(
      "top100-series",
      ctx,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].json.variables).toMatchObject({
      subtype: "TOP_100_OUT_OF_TOP_10",
      universe: "tvShow",
    });
    expect(complete).toBe(true);
    expect(entries.map((entry) => entry.externalIds?.senscritique)).toEqual([
      3, 1, 2,
    ]);
  });

  it("reads the results of a poll in their rank order", async () => {
    handler = () => ({
      data: { poll: { id: 3996052, products: [product(9), product(4)] } },
    });

    const { entries } = await senscritiqueProvider.fetchSource(
      "polls/3996052",
      ctx,
    );

    expect(requests[0].json.variables).toEqual({ id: 3996052 });
    expect(entries.map((entry) => entry.externalIds?.senscritique)).toEqual([
      9, 4,
    ]);
  });

  it.each([
    ["users/nobody/wishes", { data: { user: null } }, "not_found"],
    ["users/hidden/wishes", wishesPage([], 0, true), "private"],
    ["users/hidden/done", wishesPage([], 0, true), "private"],
    ["users/someone/shopping", {}, "not_found"],
    ["users/someone/rated/2024", {}, "not_found"],
    ["lists/1", { data: { userList: null } }, "not_found"],
    ["polls/1", { data: { poll: null } }, "not_found"],
  ])("reports %s as %s", async (ref, response, reason) => {
    handler = () => response;
    const error = await senscritiqueProvider
      .fetchSource(ref, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceUnavailableError);
    expect(error).toMatchObject({ reason });
  });

  it("sends a query again once when it times out", async () => {
    let calls = 0;
    handler = () => {
      calls += 1;
      if (calls === 1) {
        return timedOut();
      }
      return listPage([product(1)], 1);
    };

    const { entries } = await senscritiqueProvider.fetchSource("lists/1", ctx);

    expect(requests).toHaveLength(2);
    expect(entries).toHaveLength(1);
  });

  it("fails when the second try also times out", async () => {
    handler = () => {
      return timedOut();
    };

    const error = await senscritiqueProvider
      .fetchSource("lists/1", ctx)
      .catch((caught: unknown) => caught);

    expect(requests).toHaveLength(2);
    expect(error).toMatchObject({ name: "TimeoutError" });
  });

  it("treats a Cloudflare block as unavailable, not as an expected state", async () => {
    handler = () => new Response("<html>blocked</html>", { status: 403 });
    const error = await senscritiqueProvider
      .fetchSource("users/Sergent_Pepper/wishes", ctx)
      .catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(SourceUnavailableError);
  });

  it("pages through a list in its own order and keeps only films and series", async () => {
    const products = Array.from({ length: 130 }, (_, index) =>
      product(index + 1, {
        universe: index === 10 ? 3 : index % 2 === 0 ? 1 : 4,
      }),
    );
    handler = (request) => {
      const { offset, limit } = pageVariables(request);
      return listPage(products.slice(offset, offset + limit), products.length);
    };

    const { entries } = await senscritiqueProvider.fetchSource(
      "lists/369869",
      ctx,
    );

    expect(requests.map((request) => pageVariables(request).offset)).toEqual([
      0, 100,
    ]);
    expect(requests[0].json.variables.id).toBe(369869);
    const ids = entries.map((entry) => entry.externalIds?.senscritique);
    expect(ids).toHaveLength(129);
    expect([ids[0], ids.at(-1)]).toEqual([1, 130]);
    expect(ids).not.toContain(11);
  });

  it("marks a list cut by the page cap as incomplete", async () => {
    handler = (request) => {
      const { offset } = pageVariables(request);
      return listPage(
        Array.from({ length: 100 }, (_, index) => product(offset + index + 1)),
        20_000,
      );
    };

    const { entries, complete } = await onFakeClock(() =>
      senscritiqueProvider.fetchSource("lists/1", ctx),
    );

    expect(requests).toHaveLength(100);
    expect(entries).toHaveLength(10_000);
    expect(complete).toBe(false);
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

  it.each([
    ["done", "watched"],
    ["rated", "ratings"],
    ["recommend", "favorites"],
    ["current", "in progress"],
    ["liked", "likes"],
  ])("keeps the %s collection", async (name, noun) => {
    handler = () => ({
      data: {
        user: {
          username: "Sergent_Pepper",
          settings: { privacyProfile: false },
        },
      },
    });
    await expect(
      senscritiqueProvider.validateSource(`users/sergent_pepper/${name}`, ctx),
    ).resolves.toEqual({
      ok: true,
      ref: `users/Sergent_Pepper/${name}`,
      suggestedTitle: `Sergent_Pepper's ${noun}`,
      defaultDisplayMode: "split",
    });
  });

  it("keeps the year of the done collection", async () => {
    handler = () => ({
      data: {
        user: {
          username: "Sergent_Pepper",
          settings: { privacyProfile: false },
        },
      },
    });
    await expect(
      senscritiqueProvider.validateSource(
        "users/sergent_pepper/done/2024",
        ctx,
      ),
    ).resolves.toEqual({
      ok: true,
      ref: "users/Sergent_Pepper/done/2024",
      suggestedTitle: "Sergent_Pepper's watched in 2024",
      defaultDisplayMode: "split",
    });
  });

  it.each(["users/Sergent_Pepper/rated/2024", "users/Sergent_Pepper/done/24"])(
    "refuses %s without a request",
    async (ref) => {
      await expect(
        senscritiqueProvider.validateSource(ref, ctx),
      ).resolves.toEqual({ ok: false, reason: "not_found" });
      expect(requests).toHaveLength(0);
    },
  );

  it("accepts a chart without a request", async () => {
    await expect(
      senscritiqueProvider.validateSource("top111-movies", ctx),
    ).resolves.toEqual({
      ok: true,
      ref: "top111-movies",
      defaultDisplayMode: "movie",
    });
    expect(requests).toHaveLength(0);
  });

  it("uses the poll label and universe", async () => {
    handler = () => ({
      data: {
        poll: {
          id: 2582684,
          label: "Les meilleures séries de 2020",
          universe: 4,
        },
      },
    });
    await expect(
      senscritiqueProvider.validateSource("polls/2582684", ctx),
    ).resolves.toEqual({
      ok: true,
      ref: "polls/2582684",
      suggestedTitle: "Les meilleures séries de 2020",
      defaultDisplayMode: "series",
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

  it.each([
    ["users/nobody/wishes", { user: null }, "not_found"],
    ["lists/2", { userList: { isPrivate: true, universe: 1 } }, "private"],
    ["lists/3", { userList: { isPrivate: false, universe: 2 } }, "not_found"],
    ["polls/4", { poll: null }, "not_found"],
    ["polls/5", { poll: { id: 5, label: "Livres", universe: 2 } }, "not_found"],
    ["users/someone/shopping", {}, "not_found"],
    ["nonsense", {}, "not_found"],
  ])("rejects %s as %s", async (ref, data, reason) => {
    handler = () => ({ data });
    await expect(
      senscritiqueProvider.validateSource(ref, ctx),
    ).resolves.toMatchObject({ ok: false, reason });
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

  it.each([
    [1947, "1944-05-04", "1944-05-04", 1944],
    [null, "1966-07-00", null, 1966],
  ])(
    "uses the original release year, not the French one (%s, %s, %s)",
    (yearOfProduction, dateReleaseOriginal, dateRelease, year) => {
      expect(
        productToEntry(
          product(1, { yearOfProduction, dateReleaseOriginal, dateRelease }),
        )?.year,
      ).toBe(year);
    },
  );

  it.each([2, 3])("skips universe %i (books, games, music)", (universe) => {
    expect(productToEntry(product(1, { universe }))).toBeNull();
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
    const justwatch = new FakeJustWatch();
    justwatch.paths.set("/fr/film/pacific-rim", "tt1663662");
    server.use(justwatch.handler);
    const found = await justwatchPathStrategy.resolve([
      { externalIds: { justwatchPath: "/fr/film/unknown" } },
      { externalIds: { senscritique: 1 } },
      { externalIds: { justwatchPath: "/fr/film/pacific-rim" } },
    ]);
    expect([...found]).toEqual([[2, "tt1663662"]]);
    expect(
      justwatch
        .requestsOf("StremlistTitleByPath")
        .map(({ variables }) => variables.path),
    ).toEqual(["/fr/film/unknown", "/fr/film/pacific-rim"]);
    expect(requests).toHaveLength(0);
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
            { external: { value: "20" }, imdb: { value: "tt0000001" } },
            { external: { value: "20" }, imdb: { value: "tt0000002" } },
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
    await onFakeClock(() => wikidataImdbIds("P10100", ids));
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

  beforeEach(() => {
    vi.stubEnv("TMDB_READ_ACCESS_TOKEN", "test-token");
    vi.stubEnv("TMDB_API_KEY", "");
  });

  it.each([
    [
      "accepts the candidate when the director agrees",
      { year: "2014", runtime: 90, director: "Guillermo Del Toro" },
      pacificRim.directors,
      "tt1663662",
    ],
    [
      "rejects the candidate when the director disagrees, even if the runtime agrees",
      { imdbId: "tt9999999", runtime: 131, director: "Michael Bay" },
      pacificRim.directors,
      null,
    ],
    [
      "accepts on runtime and exact title when the director is unknown",
      { runtime: 125 },
      [],
      "tt1663662",
    ],
    [
      "rejects on a runtime mismatch when the director is unknown",
      { runtime: 95 },
      [],
      null,
    ],
  ])("%s", async (_, movie, directors, expected) => {
    const {
      imdbId = "tt1663662",
      year = "2013",
      runtime,
      director = "Guillermo del Toro",
    }: {
      imdbId?: string;
      year?: string;
      runtime: number;
      director?: string;
    } = movie;
    handler = ({ url }) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/3/search/movie") {
        expect(parsed.searchParams.get("language")).toBe("fr-FR");
        return {
          results: [
            { id: 1, title: "Pacific Rim", release_date: "1990-01-01" },
            {
              id: 68726,
              title: "Pacific Rim",
              original_title: "Pacific Rim",
              release_date: `${year}-07-11`,
            },
          ],
        };
      }
      if (parsed.pathname === "/3/movie/68726") {
        expect(parsed.searchParams.get("append_to_response")).toBe("credits");
        return {
          imdb_id: imdbId,
          runtime,
          credits: {
            crew: [
              { name: "Someone Else", job: "Producer" },
              { name: director, job: "Director" },
            ],
          },
        };
      }
      throw new Error(`Unexpected request ${url}`);
    };
    await expect(matchOnTmdb({ ...pacificRim, directors })).resolves.toBe(
      expected,
    );
    expect(requests.some(({ url }) => url.includes("/movie/1?"))).toBe(false);
  });

  it.each([
    [
      "rejects runtime-only matches whose title differs",
      [],
      { titles: ["Pacific Rim: Uprising"], people: [], runtimes: [131] },
      false,
    ],
    [
      "tolerates transliterated director names",
      ["Andreï Tarkovski"],
      { titles: [], people: ["Andrei Tarkovsky"], runtimes: [] },
      true,
    ],
  ])("%s", (_, directors, candidate, expected) => {
    expect(
      candidateMatches(
        { ...pacificRim, directors },
        { ...candidate, yearGap: 0 },
      ),
    ).toBe(expected);
  });

  it.each([
    ["Lee Sang-Il", "Sang-il Lee", true],
    ["Pernilla August (Pernilla Östergren)", "Pernilla August", true],
    ["Guillermo del Toro", "Guillermo Del Toro", true],
    ["Joel Coen", "Ethan Coen", false],
    ["Tony Scott", "Ridley Scott", false],
  ])("samePerson(%s, %s) is %s", (a, b, same) => {
    expect(samePerson(a, b)).toBe(same);
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
    expect(requests.some(({ url }) => url.includes("/movie/2?"))).toBe(false);
  });

  it("searches again within the year when the first page has no candidate", async () => {
    handler = ({ url }) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/3/search/movie") {
        const year = parsed.searchParams.get("year") === "1948" ? 1948 : 2012;
        return {
          results: [
            { id: year, title: "Escape", release_date: `${year}-03-01` },
          ],
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
    await expect(matchOnTmdb({ ...series, directors: [] })).resolves.toBeNull();
  });
});

describe("parseSourceLink for SensCritique", () => {
  const wishes = {
    sourceRef: "users/Sergent_Pepper/wishes",
    kind: "watchlist",
    suggestedTitle: "Sergent_Pepper's wishlist",
  };
  const done = {
    sourceRef: "users/Sergent_Pepper/done",
    kind: "history",
    suggestedTitle: "Sergent_Pepper's watched",
  };

  it.each([
    ["https://www.senscritique.com/Sergent_Pepper", wishes],
    [
      "https://www.senscritique.com/Sergent_Pepper/collection?action=WISH&universe=1",
      wishes,
    ],
    ["senscritique.com/Sergent_Pepper/listes", wishes],
    [
      "https://www.senscritique.com/Sergent_Pepper/collection?action=DONE&universe=1",
      done,
    ],
    [
      "https://www.senscritique.com/films/tops/top111",
      { sourceRef: "top111-movies", kind: "chart" },
    ],
    [
      "https://www.senscritique.com/liste/les_arcanes_du_blockbuster/369869",
      { sourceRef: "lists/369869", kind: "list" },
    ],
  ])("parses %s", (link, expected) => {
    expect(parseSourceLink(link)).toMatchObject({
      provider: "senscritique",
      ...expected,
    });
  });

  it.each([
    "https://www.senscritique.com/film/pacific_rim/473747",
    "https://www.senscritique.com/serie/generation_kill/149118",
    "https://www.senscritique.com/films",
    "https://www.senscritique.com/liste/no-id",
    "https://www.senscritique.com/Sergent_Pepper/collection?action=SHOPPING_LIST",
    "https://www.senscritique.com/",
  ])("does not parse %s as a SensCritique Source list", (link) => {
    expect(parseSourceLink(link)?.provider === "senscritique").toBe(false);
  });
});
