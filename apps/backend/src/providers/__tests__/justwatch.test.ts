import { parseSourceLink } from "@stremlist/shared/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { justwatchProvider, justwatchRecheckStrategy } from "../justwatch";
import { SourceUnavailableError } from "../types";

// Recorded from apis.justwatch.com on 2026-10-06 (public list "Sci-Fi
// Military", tl-pa-037cf385-…). The first two titles have IMDb IDs; the last
// two have none on JustWatch.
const HALO_4 = {
  node: {
    id: "ts44021",
    objectType: "SHOW",
    content: {
      title: "Halo 4: Forward Unto Dawn",
      originalReleaseYear: 2012,
      externalIds: { imdbId: "tt2262308", tmdbId: "56295" },
    },
  },
};
const TERMINATION_POINT = {
  node: {
    id: "tm37681",
    objectType: "MOVIE",
    content: {
      title: "Termination Point",
      originalReleaseYear: 2007,
      externalIds: { imdbId: "tt0898949", tmdbId: "55914" },
    },
  },
};
const ROBOCOP = {
  node: {
    id: "tm18591",
    objectType: "MOVIE",
    content: {
      title: "RoboCop: Prime Directives",
      originalReleaseYear: 2001,
      externalIds: { imdbId: null, tmdbId: "74236" },
    },
  },
};
const HALO = {
  node: {
    id: "ts397055",
    objectType: "SHOW",
    content: {
      title: "Halo",
      originalReleaseYear: 2001,
      externalIds: { imdbId: null, tmdbId: "231220" },
    },
  },
};

const PUBLIC_LIST_ID = "tl-pa-037cf385-37d5-45a3-921f-f0606dd8a17a";
const CUSTOM_LIST_ID = "tl-us-3f1c2a9e-7b4d-4e2a-9c1f-0a2b3c4d5e6f";

function listPage(options: {
  id?: string;
  type?: string;
  visibility?: string;
  name?: string;
  contentName?: string | null;
  edges: unknown[];
  totalCount: number;
  endCursor: string;
  hasNextPage: boolean;
}) {
  return {
    data: {
      node: {
        __typename: "GenericTitleList",
        id: options.id ?? PUBLIC_LIST_ID,
        type: options.type ?? "PERMANENT_AUDIENCE_LIST",
        visibility: options.visibility ?? "PUBLIC",
        name: options.name ?? "",
        content:
          options.contentName === null
            ? null
            : { name: options.contentName ?? "Sci-Fi Military" },
        titles: {
          totalCount: options.totalCount,
          pageInfo: {
            hasNextPage: options.hasNextPage,
            endCursor: options.endCursor,
          },
          edges: options.edges,
        },
      },
    },
  };
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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
        jsonResponse(
          listPage({
            edges: [HALO_4, TERMINATION_POINT],
            totalCount: 4,
            endCursor: "Mg==",
            hasNextPage: true,
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          listPage({
            edges: [ROBOCOP, HALO],
            totalCount: 4,
            endCursor: "NA==",
            hasNextPage: false,
          }),
        ),
      );

    const { entries, complete } = await justwatchProvider.fetchSource(
      PUBLIC_LIST_ID,
      { connection: null },
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
      jsonResponse(
        listPage({
          id: CUSTOM_LIST_ID,
          type: "USER_LIST",
          visibility: "UNLISTED",
          contentName: "Weekend",
          edges: [HALO_4, TERMINATION_POINT, ROBOCOP],
          totalCount: 3,
          endCursor: "Mw==",
          hasNextPage: false,
        }),
      ),
    );

    const { entries } = await justwatchProvider.fetchSource(CUSTOM_LIST_ID, {
      connection: null,
    });

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
        jsonResponse(
          listPage({
            edges,
            totalCount: 5_000,
            endCursor: btoa(String(served)),
            hasNextPage: true,
          }),
        ),
      );
    });

    const { entries, complete } = await justwatchProvider.fetchSource(
      PUBLIC_LIST_ID,
      { connection: null },
    );

    expect(entries).toHaveLength(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    // The cap left titles out: not a complete synchronization (ADR 0007).
    expect(complete).toBe(false);
  });

  it("keeps entries without content or a known type", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        listPage({
          edges: [
            { node: { id: "tm1", objectType: "MOVIE", content: null } },
            { node: { id: "tse5", objectType: "SHOW_SEASON", content: null } },
            null,
          ],
          totalCount: 3,
          endCursor: "Mw==",
          hasNextPage: false,
        }),
      ),
    );

    const { entries } = await justwatchProvider.fetchSource(PUBLIC_LIST_ID, {
      connection: null,
    });

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
    fetchMock.mockResolvedValueOnce(jsonResponse(NOT_FOUND));

    const error = await justwatchProvider
      .fetchSource(CUSTOM_LIST_ID, { connection: null })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SourceUnavailableError);
    expect((error as SourceUnavailableError).reason).toBe("not_found");
  });

  it("rejects a ref that is not a list ID without a request", async () => {
    const error = await justwatchProvider
      .fetchSource("tm18591", { connection: null })
      .catch((caught: unknown) => caught);

    expect((error as SourceUnavailableError).reason).toBe("not_found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats other GraphQL errors as failures, not as a deleted list", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        errors: [{ message: "upstream timeout" }],
        data: { node: null },
      }),
    );

    const error = await justwatchProvider
      .fetchSource(CUSTOM_LIST_ID, { connection: null })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SourceUnavailableError);
  });

  it("fails on an HTTP error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));

    await expect(
      justwatchProvider.fetchSource(CUSTOM_LIST_ID, { connection: null }),
    ).rejects.toThrow(/503/);
  });
});

describe("justwatchProvider.validateSource", () => {
  it("returns the list name as the suggested title", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        listPage({
          edges: [HALO_4],
          totalCount: 108,
          endCursor: "MQ==",
          hasNextPage: true,
        }),
      ),
    );

    const result = await justwatchProvider.validateSource(
      ` ${PUBLIC_LIST_ID.toUpperCase()} `,
      { connection: null },
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
      jsonResponse(
        listPage({
          id: CUSTOM_LIST_ID,
          type: "USER_LIST",
          visibility: "UNLISTED",
          contentName: null,
          edges: [],
          totalCount: 0,
          endCursor: "",
          hasNextPage: false,
        }),
      ),
    );

    const result = await justwatchProvider.validateSource(CUSTOM_LIST_ID, {
      connection: null,
    });

    expect(result).toMatchObject({
      ok: true,
      suggestedTitle: "JustWatch list",
    });
  });

  it("reports a deleted list as not found", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(NOT_FOUND));

    const result = await justwatchProvider.validateSource(CUSTOM_LIST_ID, {
      connection: null,
    });

    expect(result).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("rejects a malformed ref without a request", async () => {
    const result = await justwatchProvider.validateSource("not a list", {
      connection: null,
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
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
      jsonResponse({
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
      Promise.resolve(jsonResponse({ data: { nodes: [] } })),
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
      ref,
      kind: "list",
      requiresConnection: false,
    });
  });

  it("ignores JustWatch links without a list", () => {
    expect(
      parseSourceLink("https://www.justwatch.com/us/movie/inception"),
    ).toBeNull();
  });
});
