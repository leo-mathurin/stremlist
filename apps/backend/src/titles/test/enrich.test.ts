import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { http, HttpResponse } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { FakeImdb, IMDB_GRAPHQL } from "../../test/helpers/imdb.test-utils";
import {
  unexpectedRequest,
  useMswServer,
} from "../../test/helpers/msw.test-utils";
import { enrichTitles } from "../enrich";

let nextId = 1000000;
function freshId() {
  nextId += 1;
  return `tt${nextId}`;
}

function meta(id: string, overrides: Partial<StremioMeta> = {}) {
  const value: StremioMeta = {
    id,
    type: "movie",
    name: `IMDb ${id}`,
    poster: null,
    posterShape: "poster",
    genres: [],
    description: "",
    ...overrides,
  };
  return value;
}

function fresh(m: StremioMeta) {
  const value: StremioMeta & { enrichedAt: string } = {
    ...m,
    enrichedAt: new Date().toISOString(),
  };
  return value;
}

const imdb = new FakeImdb();
const server = useMswServer();
let cinemetaRequests: Request[];

function cinemetaUrl(type: string, id: string) {
  return `https://v3-cinemeta.strem.io/meta/${type}/${id}.json`;
}

function serveCinemeta(respond: (url: string, request: Request) => Response) {
  server.use(
    http.get("https://v3-cinemeta.strem.io/meta/:type/:id", ({ request }) => {
      cinemetaRequests.push(request);
      return respond(request.url, request);
    }),
  );
}

function requestedUrls() {
  return cinemetaRequests.map((request) => request.url);
}

function imdbDown() {
  server.use(
    http.post(IMDB_GRAPHQL, () => new HttpResponse(null, { status: 503 })),
  );
}

function titleBatches() {
  return imdb.requestsOf("TitlesById").map(({ variables }) => variables.ids);
}

beforeEach(() => {
  imdb.reset();
  cinemetaRequests = [];
  server.use(imdb.handler);
  serveCinemeta(() => new HttpResponse("not found", { status: 404 }));
  vi.spyOn(console, "error");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("enrichTitles", () => {
  it("does not renew the enrichment timestamp on memory reuse", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = freshId();
    const at = new Date("2026-02-01T00:00:00Z");
    vi.setSystemTime(at);
    imdb.titles.set(id, meta(id));
    await enrichTitles([{ imdbId: id }]);
    vi.setSystemTime(at.getTime() + 60 * 60_000);
    expect((await enrichTitles([{ imdbId: id }])).get(id)?.enrichedAt).toBe(
      at.toISOString(),
    );
  });

  it("re-enriches expired and undated metadata while retaining recent entries", async () => {
    const [old, legacy, recent] = [freshId(), freshId(), freshId()];
    const previous = new Map<string, StremioMeta & { enrichedAt?: string }>([
      [
        old,
        {
          ...meta(old),
          enrichedAt: new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(),
        },
      ],
      [legacy, meta(legacy)],
      [recent, fresh(meta(recent))],
    ]);
    for (const id of [old, legacy, recent]) {
      imdb.titles.set(id, meta(id, { imdbRating: "8.7" }));
    }
    const result = await enrichTitles(
      [old, legacy, recent].map((imdbId) => ({ imdbId })),
      previous,
    );
    expect(titleBatches()).toEqual([[old, legacy]]);
    expect(result.get(old)?.imdbRating).toBe("8.7");
    expect(result.get(legacy)?.enrichedAt).toBeDefined();
    expect(result.get(recent)).toEqual(previous.get(recent));
  });

  it("reuses metadata from the previous cache generation without any lookup", async () => {
    const id = freshId();
    const previous = new Map([[id, fresh(meta(id, { name: "Cached" }))]]);

    const result = await enrichTitles([{ imdbId: id }], previous);

    expect(result.get(id)?.name).toBe("Cached");
    expect(imdb.requests).toEqual([]);
    expect(requestedUrls()).toEqual([]);
  });

  it("asks IMDb in one batch for every unknown Title", async () => {
    const [a, b, known] = [freshId(), freshId(), freshId()];
    for (const id of [a, b, known]) imdb.titles.set(id, meta(id));

    const result = await enrichTitles(
      [{ imdbId: a }, { imdbId: known }, { imdbId: b }, { imdbId: a }],
      new Map([[known, fresh(meta(known, { name: "Known" }))]]),
    );

    expect(titleBatches()).toEqual([[a, b]]);
    expect([...result.keys()].sort()).toEqual([a, b, known].sort());
    expect(requestedUrls()).toEqual([]);
  });

  it("remembers IMDb answers for the next refresh", async () => {
    const id = freshId();
    imdb.titles.set(id, meta(id));

    await enrichTitles([{ imdbId: id }]);
    const again = await enrichTitles([{ imdbId: id }]);

    expect(again.get(id)?.name).toBe(`IMDb ${id}`);
    expect(titleBatches()).toHaveLength(1);
  });

  it("falls back to Cinemeta when IMDb throws", async () => {
    const id = freshId();
    imdbDown();
    serveCinemeta((url, request) =>
      url === cinemetaUrl("series", id)
        ? HttpResponse.json({
            meta: {
              name: "From Cinemeta",
              poster: "https://img.example/p.jpg",
              genres: ["Drama"],
              description: "A show.",
              imdbRating: "8.1",
              releaseInfo: "2019-2023",
              runtime: "45 min",
              released: "2019-01-01T00:00:00.000Z",
              director: ["Someone"],
              cast: ["A", "B", "C", "D", "E", "F"],
            },
          })
        : unexpectedRequest(request),
    );

    const result = await enrichTitles([{ imdbId: id, type: "series" }]);

    expect(requestedUrls()).toEqual([cinemetaUrl("series", id)]);
    expect(result.get(id)).toMatchObject({
      id,
      type: "series",
      name: "From Cinemeta",
      poster: "https://img.example/p.jpg",
      posterShape: "poster",
      genres: ["Drama"],
      description: "A show.",
      imdbRating: "8.1",
      releaseInfo: "2019",
      runtime: "45m",
      released: "2019-01-01T00:00:00.000Z",
      director: ["Someone"],
      cast: ["A", "B", "C", "D", "E"],
    });
    expect(cinemetaRequests[0].headers.get("User-Agent")).toMatch(
      /^Stremlist\//,
    );
  });

  it("asks only Cinemeta when IMDb is turned off", async () => {
    const id = freshId();
    process.env.DISABLED_PROVIDERS = "imdb";
    try {
      await enrichTitles([{ imdbId: id, type: "movie" }]);
    } finally {
      delete process.env.DISABLED_PROVIDERS;
    }

    expect(imdb.requests).toEqual([]);
    expect(requestedUrls()).toEqual([cinemetaUrl("movie", id)]);
  });

  it("asks Cinemeta only for Titles that IMDb did not answer", async () => {
    const [fromImdb, missing] = [freshId(), freshId()];
    imdb.titles.set(fromImdb, meta(fromImdb));
    serveCinemeta(() => HttpResponse.json({ meta: { name: "From Cinemeta" } }));

    const result = await enrichTitles([
      { imdbId: fromImdb, type: "movie" },
      { imdbId: missing, type: "movie" },
    ]);

    expect(requestedUrls()).toEqual([cinemetaUrl("movie", missing)]);
    expect(result.get(missing)?.name).toBe("From Cinemeta");
  });

  it("tries movie then series when the type is unknown", async () => {
    const id = freshId();
    imdbDown();
    serveCinemeta((url) =>
      url === cinemetaUrl("series", id)
        ? HttpResponse.json({ meta: { name: "A series" } })
        : HttpResponse.json({ meta: null }),
    );

    const result = await enrichTitles([{ imdbId: id }]);

    expect(requestedUrls()).toEqual([
      cinemetaUrl("movie", id),
      cinemetaUrl("series", id),
    ]);
    expect(result.get(id)).toMatchObject({ type: "series", name: "A series" });
  });

  it("leaves a Title out when nobody knows it, without throwing", async () => {
    const id = freshId();
    imdbDown();
    serveCinemeta(() => HttpResponse.error());

    const result = await enrichTitles([{ imdbId: id, type: "movie" }]);

    expect(result.has(id)).toBe(false);
  });
});
