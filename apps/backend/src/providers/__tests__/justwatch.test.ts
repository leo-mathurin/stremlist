import { parseSourceLink } from "@stremlist/shared/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { justwatchRecheckStrategy } from "../../titles/justwatch-lookup";
import { justwatchProvider } from "../justwatch";
import { SourceUnavailableError } from "../types";

function edge(
  id: string,
  objectType: string,
  title: string,
  originalReleaseYear: number,
  imdbId: string | null,
  tmdbId: string,
) {
  return {
    node: {
      id,
      objectType,
      content: { title, originalReleaseYear, externalIds: { imdbId, tmdbId } },
    },
  };
}

// Recorded from apis.justwatch.com on 2026-10-06 (public list "Sci-Fi
// Military", tl-pa-037cf385-…). The first two titles have IMDb IDs; the last
// two have none on JustWatch.
const HALO_4 = edge(
  "ts44021",
  "SHOW",
  "Halo 4: Forward Unto Dawn",
  2012,
  "tt2262308",
  "56295",
);
const TERMINATION_POINT = edge(
  "tm37681",
  "MOVIE",
  "Termination Point",
  2007,
  "tt0898949",
  "55914",
);
const ROBOCOP = edge(
  "tm18591",
  "MOVIE",
  "RoboCop: Prime Directives",
  2001,
  null,
  "74236",
);
const HALO = edge("ts397055", "SHOW", "Halo", 2001, null, "231220");

const PUBLIC_LIST_ID = "tl-pa-037cf385-37d5-45a3-921f-f0606dd8a17a";
const CUSTOM_LIST_ID = "tl-us-3f1c2a9e-7b4d-4e2a-9c1f-0a2b3c4d5e6f";
const CUSTOM_LIST = {
  id: CUSTOM_LIST_ID,
  type: "USER_LIST",
  visibility: "UNLISTED",
};

function listPage(
  edges: unknown[],
  { endCursor = "", hasNextPage = false } = {},
  node: Record<string, unknown> = {},
) {
  return Response.json({
    data: {
      node: {
        __typename: "GenericTitleList",
        id: PUBLIC_LIST_ID,
        type: "PERMANENT_AUDIENCE_LIST",
        visibility: "PUBLIC",
        name: "",
        content: { name: "Sci-Fi Military" },
        titles: {
          totalCount: edges.length,
          pageInfo: { hasNextPage, endCursor },
          edges,
        },
        ...node,
      },
    },
  });
}

// Recorded response for a deleted list or a bad ID.
const NOT_FOUND = {
  errors: [
    {
      message: "rpc error: code = NotFound desc = not found not found",
      path: ["node"],
      extensions: { code: "INTERNAL_ERROR" },
    },
  ],
  data: { node: null },
};

interface GraphQLBody {
  query: string;
  variables: Record<string, unknown>;
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function parseBody(init: RequestInit | undefined): GraphQLBody {
  return JSON.parse(init?.body as string) as GraphQLBody;
}

function requestBodies(): GraphQLBody[] {
  return fetchMock.mock.calls.map(([, init]) => parseBody(init));
}

const ctx = { connection: null };

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("justwatchProvider.fetchSource", () => {
  it("reads every page and maps the titles", async () => {
    fetchMock
      .mockResolvedValueOnce(
        listPage([HALO_4, TERMINATION_POINT], {
          endCursor: "Mg==",
          hasNextPage: true,
        }),
      )
      .mockResolvedValueOnce(listPage([ROBOCOP, HALO], { endCursor: "NA==" }));

    const { entries, complete } = await justwatchProvider.fetchSource(
      PUBLIC_LIST_ID,
      ctx,
    );
    expect(complete).toBe(true);

    expect(entries).toEqual([
      {
        imdbId: "tt2262308",
        externalIds: {
          justwatch: "ts44021",
          tmdb: { id: 56295, type: "series" },
        },
        type: "series",
        title: "Halo 4: Forward Unto Dawn",
        year: 2012,
      },
      {
        imdbId: "tt0898949",
        externalIds: {
          justwatch: "tm37681",
          tmdb: { id: 55914, type: "movie" },
        },
        type: "movie",
        title: "Termination Point",
        year: 2007,
      },
      {
        imdbId: undefined,
        externalIds: {
          justwatch: "tm18591",
          tmdb: { id: 74236, type: "movie" },
        },
        type: "movie",
        title: "RoboCop: Prime Directives",
        year: 2001,
      },
      {
        imdbId: undefined,
        externalIds: {
          justwatch: "ts397055",
          tmdb: { id: 231220, type: "series" },
        },
        type: "series",
        title: "Halo",
        year: 2001,
      },
    ]);

    const bodies = requestBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0].variables).toMatchObject({
      id: PUBLIC_LIST_ID,
      country: "US",
      language: "en",
      after: null,
    });
    expect(bodies[1].variables).toMatchObject({ after: "Mg==" });
    // Without this filter, titles that have no page in the country vanish.
    expect(bodies[0].query).toContain("includeTitlesWithoutUrl: true");
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get("User-Agent")).toMatch(
      /^Stremlist\//,
    );
  });

  it("keeps a custom list in the API order, which is oldest added first", async () => {
    fetchMock.mockResolvedValueOnce(
      listPage([HALO_4, TERMINATION_POINT, ROBOCOP], {}, CUSTOM_LIST),
    );

    const { entries } = await justwatchProvider.fetchSource(
      CUSTOM_LIST_ID,
      ctx,
    );

    expect(entries.map((entry) => entry.externalIds?.justwatch)).toEqual([
      HALO_4.node.id,
      TERMINATION_POINT.node.id,
      ROBOCOP.node.id,
    ]);
  });

  it("stops at the entry cap", async () => {
    let served = 0;
    fetchMock.mockImplementation((_url, init) => {
      const first = parseBody(init).variables.first as number;
      const edges = Array.from({ length: first }, (_, index) => ({
        node: { ...TERMINATION_POINT.node, id: `tm${served + index + 1}` },
      }));
      served += edges.length;
      return Promise.resolve(
        listPage(edges, { endCursor: btoa(String(served)), hasNextPage: true }),
      );
    });

    const { entries, complete } = await justwatchProvider.fetchSource(
      PUBLIC_LIST_ID,
      ctx,
    );

    expect(entries).toHaveLength(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    // The cap left titles out: not a complete synchronization (ADR 0007).
    expect(complete).toBe(false);
  });

  it("keeps entries without content or a known type", async () => {
    fetchMock.mockResolvedValueOnce(
      listPage([
        { node: { id: "tm1", objectType: "MOVIE", content: null } },
        { node: { id: "tse5", objectType: "SHOW_SEASON", content: null } },
        null,
      ]),
    );

    const { entries } = await justwatchProvider.fetchSource(
      PUBLIC_LIST_ID,
      ctx,
    );

    expect(entries).toEqual([
      {
        imdbId: undefined,
        externalIds: { justwatch: "tm1", tmdb: undefined },
        type: "movie",
        title: undefined,
        year: undefined,
      },
      {
        imdbId: undefined,
        externalIds: { justwatch: "tse5", tmdb: undefined },
        type: undefined,
        title: undefined,
        year: undefined,
      },
    ]);
  });

  it("reports a deleted list as not found", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(NOT_FOUND));
    const error = await justwatchProvider
      .fetchSource(CUSTOM_LIST_ID, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceUnavailableError);
    expect((error as SourceUnavailableError).reason).toBe("not_found");
  });

  it("rejects a ref that is not a list ID without a request", async () => {
    await expect(
      justwatchProvider.fetchSource("tm18591", ctx),
    ).rejects.toMatchObject({ reason: "not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats other GraphQL errors as failures, not as a deleted list", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        errors: [{ message: "upstream timeout" }],
        data: { node: null },
      }),
    );
    const error = await justwatchProvider
      .fetchSource(CUSTOM_LIST_ID, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SourceUnavailableError);
  });

  it("fails on an HTTP error", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    await expect(
      justwatchProvider.fetchSource(CUSTOM_LIST_ID, ctx),
    ).rejects.toThrow(/503/);
  });
});

describe("justwatchProvider.validateSource", () => {
  it("returns the list name as the suggested title", async () => {
    fetchMock.mockResolvedValueOnce(
      listPage([HALO_4], { endCursor: "MQ==", hasNextPage: true }),
    );

    const result = await justwatchProvider.validateSource(
      ` ${PUBLIC_LIST_ID.toUpperCase()} `,
      ctx,
    );

    expect(result).toEqual({
      ok: true,
      ref: PUBLIC_LIST_ID,
      suggestedTitle: "Sci-Fi Military",
      defaultDisplayMode: "split",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBodies()[0].variables).toMatchObject({ first: 1 });
  });

  it("falls back to a generic title when the list has no name", async () => {
    fetchMock.mockResolvedValueOnce(
      listPage([], {}, { ...CUSTOM_LIST, content: null }),
    );
    await expect(
      justwatchProvider.validateSource(CUSTOM_LIST_ID, ctx),
    ).resolves.toMatchObject({ ok: true, suggestedTitle: "JustWatch list" });
  });

  it("reports a deleted list as not found", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(NOT_FOUND));
    await expect(
      justwatchProvider.validateSource(CUSTOM_LIST_ID, ctx),
    ).rejects.toMatchObject({
      name: "SourceUnavailableError",
      reason: "not_found",
    });
  });

  it("rejects a malformed ref without a request", async () => {
    await expect(
      justwatchProvider.validateSource("not a list", ctx),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("JustWatch ID resolution", () => {
  it("keys entries by their JustWatch node ID", () => {
    expect(
      justwatchProvider.resolutionKey?.({
        externalIds: { justwatch: "tm18591" },
      }),
    ).toEqual({ namespace: "justwatch", externalId: "tm18591" });
    expect(justwatchProvider.resolutionKey?.({ title: "Halo" })).toBeNull();
  });

  it("tries TMDB first, then asks JustWatch again", () => {
    expect(
      justwatchProvider.resolverStrategies?.map((strategy) => strategy.name),
    ).toEqual(["tmdb-external-ids", "justwatch-recheck"]);
  });

  it("re-reads the IMDb IDs of the nodes", async () => {
    // Recorded shape: an unknown node nulls only its own slot.
    fetchMock.mockResolvedValueOnce(
      Response.json({
        errors: [
          {
            message:
              "resolver.findMergedTitle: no merge target found for tm999999999",
            path: ["nodes", 0, "content"],
            extensions: { code: "INTERNAL_ERROR" },
          },
        ],
        data: {
          nodes: [
            null,
            {
              id: "tm18591",
              content: { externalIds: { imdbId: "tt0300000" } },
            },
            { id: "ts397055", content: { externalIds: { imdbId: null } } },
          ],
        },
      }),
    );

    const found = await justwatchRecheckStrategy.resolve([
      { externalIds: { justwatch: "tm999999999" } },
      { externalIds: { justwatch: "ts397055" } },
      { title: "No JustWatch ID" },
      { externalIds: { justwatch: "tm18591" } },
    ]);

    expect([...found]).toEqual([[3, "tt0300000"]]);
    expect(requestBodies()[0].variables).toEqual({
      ids: ["tm999999999", "ts397055", "tm18591"],
    });
  });

  it("asks in chunks of 50 node IDs", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ data: { nodes: [] } })),
    );

    await justwatchRecheckStrategy.resolve(
      Array.from({ length: 120 }, (_, index) => ({
        externalIds: { justwatch: `tm${index + 1}` },
      })),
    );

    expect(
      requestBodies().map((body) => (body.variables.ids as string[]).length),
    ).toEqual([50, 50, 20]);
  });

  it("makes no request when no entry has a node ID", async () => {
    const found = await justwatchRecheckStrategy.resolve([{ title: "Halo" }]);

    expect(found.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("JustWatch links", () => {
  const uuid = "3f1c2a9e-7b4d-4e2a-9c1f-0a2b3c4d5e6f";

  it.each([
    [`https://www.justwatch.com/shared?id=tl-us-${uuid}`, `tl-us-${uuid}`],
    [
      `https://www.justwatch.com/fr/lists/my-lists?inner_tab=custom_lists&list_id=tl-us-${uuid}`,
      `tl-us-${uuid}`,
    ],
    [
      `https://www.justwatch.com/us/lists/public-lists?list_id=tl-pa-${uuid}`,
      `tl-pa-${uuid}`,
    ],
    [`justwatch.com/shared?id=TL-US-${uuid.toUpperCase()}`, `tl-us-${uuid}`],
    [`tl-us-${uuid}`, `tl-us-${uuid}`],
  ])("parses %s", (link, ref) => {
    expect(parseSourceLink(link)).toEqual({
      provider: "justwatch",
      sourceRef: ref,
      kind: "list",
    });
  });

  it("ignores JustWatch links without a list", () => {
    expect(
      parseSourceLink("https://www.justwatch.com/us/movie/inception"),
    ).toBeNull();
  });
});
