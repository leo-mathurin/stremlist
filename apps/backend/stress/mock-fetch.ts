// Replaces outbound Provider calls with a fake IMDb GraphQL API. Local calls
// (Supabase, the R2 container) pass through. Every other external host is
// counted and answered with a fast 503, so unexpected outbound traffic shows
// up in the report, and Trakt behaves as if it were down.

const realFetch = globalThis.fetch;
const BASE_LATENCY = Number(process.env.MOCK_BASE_MS ?? 300);
const PER_ITEM = Number(process.env.MOCK_PER_ITEM_MS ?? 0.3);
const DRIFT = process.env.MOCK_DRIFT === "1";
const POOL = 30_000;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const stats = {
  hosts: {} as Record<string, number>,
  imdbPages: 0,
  imdbItems: 0,
  inflight: 0,
  maxInflight: 0,
};

export function resetStats(): void {
  stats.hosts = {};
  stats.imdbPages = 0;
  stats.imdbItems = 0;
  stats.maxInflight = stats.inflight;
}

function hash(value: string): number {
  let h = 2166136261;
  for (const char of value) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** 60% 20-200, 30% 200-1,000, 9% 1,000-3,000, 1% 5,000-12,000 titles. */
function watchlistSize(id: string): number {
  const h = hash(id);
  const bucket = h % 100;
  const spread = (h >>> 8) % 1000;
  if (bucket < 60) return 20 + (spread % 180);
  if (bucket < 90) return 200 + (spread % 800);
  if (bucket < 99) return 1000 + spread * 2;
  return 5000 + spread * 7;
}

/** About 3% of the watchlists and lists are private. */
function isPrivate(id: string): boolean {
  return hash(`p${id}`) % 100 < 3;
}

const GENRES = [
  "Drama",
  "Comedy",
  "Action",
  "Thriller",
  "Sci-Fi",
  "Horror",
  "Romance",
  "Animation",
];

function genre(index: number): { genre: { text: string } } {
  return { genre: { text: GENRES[index % GENRES.length] ?? "Drama" } };
}

function title(i: number) {
  const id = `tt${String(9_000_000 + i)}`;
  const year = 1950 + (i % 75);
  return {
    id,
    titleText: { text: `Stress Title ${String(i)}` },
    titleType: { text: i % 4 === 0 ? "TV Series" : "Movie" },
    releaseYear: { year },
    releaseDate: { year, month: 1 + (i % 12), day: 1 + (i % 28) },
    ratingsSummary: { aggregateRating: 5 + (i % 50) / 10 },
    titleGenres: { genres: [genre(i), genre(i * 7)] },
    plot: {
      plotText: { plainText: `Plot of stress title ${String(i)}. `.repeat(4) },
    },
    primaryImage: { url: `https://m.media-amazon.com/images/M/${id}.jpg` },
    runtime: { seconds: 5400 + (i % 3600) },
    principalCredits: [
      {
        category: { id: "director" },
        credits: [
          { name: { nameText: { text: `Director ${String(i % 500)}` } } },
        ],
      },
      {
        category: { id: "cast" },
        credits: [1, 2, 3].map((k) => ({
          name: { nameText: { text: `Actor ${String((i * k) % 2000)}` } },
        })),
      },
    ],
  };
}

/** Title indexes of a list. With drift, lists grow by one title a minute. */
function itemsFor(id: string): number[] {
  const drift = DRIFT ? Math.floor(Date.now() / 60_000) % 50 : 0;
  const start = hash(id) % POOL;
  const stride = 1 + (hash(`s${id}`) % 7);
  return Array.from(
    { length: watchlistSize(id) + drift },
    (_, k) => (start + k * stride) % POOL,
  );
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

interface GraphQLBody {
  operationName?: string;
  variables?: Record<string, unknown>;
}

function stringVar(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function imdb(body: GraphQLBody): Promise<Response> {
  const op = body.operationName ?? "";
  const vars = body.variables ?? {};
  const key = stringVar(vars.urConst) || stringVar(vars.listId);
  stats.imdbPages++;

  if (op === "ValidateWatchlist" || op === "ValidateList") {
    await sleep(BASE_LATENCY / 2);
    const visibility = { id: isPrivate(key) ? "PRIVATE" : "PUBLIC" };
    return json({
      data:
        op === "ValidateList"
          ? { list: { id: key, visibility } }
          : { predefinedList: { id: key, visibility } },
    });
  }

  if (op === "WatchListPage" || op === "ListPage") {
    if (isPrivate(key)) {
      await sleep(BASE_LATENCY);
      return json({
        errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }],
      });
    }
    const all = itemsFor(key);
    const offset = Number(stringVar(vars.after) || 0);
    const first = typeof vars.first === "number" ? vars.first : 250;
    const slice = all.slice(offset, offset + first);
    stats.imdbItems += slice.length;
    await sleep(BASE_LATENCY + slice.length * PER_ITEM);
    const end = offset + slice.length;
    const hasNextPage = end < all.length;
    const container = {
      id: key,
      visibility: { id: "PUBLIC" },
      name: { originalText: "List" },
      titleListItemSearch: {
        total: all.length,
        pageInfo: { hasNextPage, endCursor: hasNextPage ? String(end) : null },
        edges: slice.map((i) => ({
          node: {
            createdDate: new Date(
              Date.UTC(2020, 0, 1) + i * 3_600_000,
            ).toISOString(),
          },
          listItem: title(i),
        })),
      },
    };
    return json({
      data:
        op === "ListPage" ? { list: container } : { predefinedList: container },
    });
  }

  // Charts: 100 titles on a single page.
  await sleep(BASE_LATENCY);
  const edges = Array.from({ length: 100 }, (_, k) => ({
    node: title((hash(op) + k) % POOL),
  }));
  return json({
    data: {
      chartTitles: {
        total: 100,
        pageInfo: { hasNextPage: false, endCursor: null },
        edges,
      },
      comingSoon: { edges },
      topGrossingReleases: { edges: [] },
    },
  });
}

async function requestBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<string> {
  if (typeof init?.body === "string") return init.body;
  if (input instanceof Request) return input.text();
  return "{}";
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (LOCAL_HOSTS.has(url.hostname)) return realFetch(input, init);
    stats.hosts[url.host] = (stats.hosts[url.host] ?? 0) + 1;
    stats.inflight++;
    stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
    try {
      if (url.host === "api.graphql.imdb.com") {
        const body = JSON.parse(await requestBody(input, init)) as GraphQLBody;
        return await imdb(body);
      }
      await sleep(50);
      return new Response("mocked: not available", { status: 503 });
    } finally {
      stats.inflight--;
    }
  },
  realFetch,
);
