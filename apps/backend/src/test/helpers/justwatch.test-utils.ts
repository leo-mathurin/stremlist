import { http, HttpResponse } from "msw";
import { z } from "zod";

export const JUSTWATCH_GRAPHQL = "https://apis.justwatch.com/graphql";

/** A JustWatch title, as the list and node queries return it. */
export interface JustWatchTitle {
  id: string;
  objectType: "MOVIE" | "SHOW";
  title: string;
  originalReleaseYear: number;
  imdbId: string | null;
  tmdbId: string;
}

/** A JustWatch list: the titles in list order, with its public name. */
export interface JustWatchList {
  type?: string;
  visibility?: string;
  name?: string;
  titles: JustWatchTitle[];
}

const graphQLBody = z.object({
  query: z.string(),
  variables: z
    .object({
      id: z.string().optional(),
      ids: z.array(z.string()).optional(),
      path: z.string().optional(),
      first: z.number().optional(),
      after: z.string().nullish(),
    })
    .loose(),
});

/** One GraphQL request that the fake JustWatch API received. */
export type JustWatchRequest = z.infer<typeof graphQLBody> & {
  operation: string;
  headers: Headers;
};

function node(title: JustWatchTitle) {
  return {
    id: title.id,
    objectType: title.objectType,
    content: {
      title: title.title,
      originalReleaseYear: title.originalReleaseYear,
      externalIds: { imdbId: title.imdbId, tmdbId: title.tmdbId },
    },
  };
}

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

/**
 * The JustWatch GraphQL API in memory. It serves the lists and titles that
 * a test stores, page by page with base64 offset cursors as JustWatch does,
 * resolves title paths and node IDs to IMDb IDs, and keeps every request.
 */
export class FakeJustWatch {
  readonly lists = new Map<string, JustWatchList>();
  readonly titles = new Map<string, JustWatchTitle>();
  /** IMDb IDs by JustWatch path, for example `/fr/film/dune`. */
  readonly paths = new Map<string, string>();
  readonly requests: JustWatchRequest[] = [];
  /** When set, every request fails with this HTTP status. */
  failStatus: number | null = null;

  /** The MSW handler of the JustWatch GraphQL endpoint. */
  readonly handler = http.post(JUSTWATCH_GRAPHQL, ({ request }) =>
    this.answer(request),
  );

  reset() {
    this.lists.clear();
    this.titles.clear();
    this.paths.clear();
    this.requests.length = 0;
    this.failStatus = null;
  }

  /** Stores a list and its titles. */
  serveList(id: string, list: JustWatchList) {
    this.lists.set(id, list);
    for (const title of list.titles) this.titles.set(title.id, title);
  }

  /** The requests of this GraphQL operation, for example `StremlistJustwatchList`. */
  requestsOf(operation: string) {
    return this.requests.filter((request) => request.operation === operation);
  }

  async answer(request: Request) {
    const body = graphQLBody.parse(await request.json());
    const operation = /query (\w+)/.exec(body.query)?.[1] ?? "";
    this.requests.push({ ...body, operation, headers: request.headers });
    if (this.failStatus !== null) {
      return new HttpResponse("Unavailable", { status: this.failStatus });
    }
    const { variables } = body;
    switch (operation) {
      case "StremlistJustwatchList": {
        const list = this.lists.get(variables.id ?? "");
        if (!list) return HttpResponse.json(NOT_FOUND);
        const offset = variables.after
          ? Number(Buffer.from(variables.after, "base64").toString())
          : 0;
        const first = variables.first ?? list.titles.length;
        const page = list.titles.slice(offset, offset + first);
        const end = offset + page.length;
        return HttpResponse.json({
          data: {
            node: {
              __typename: "GenericTitleList",
              id: variables.id,
              type: list.type ?? "PERMANENT_AUDIENCE_LIST",
              visibility: list.visibility ?? "PUBLIC",
              name: "",
              content: { name: list.name ?? "" },
              titles: {
                totalCount: list.titles.length,
                pageInfo: {
                  hasNextPage: end < list.titles.length,
                  endCursor: Buffer.from(String(end)).toString("base64"),
                },
                edges: page.map((title) => ({ node: node(title) })),
              },
            },
          },
        });
      }
      case "StremlistTitlesByNodeIds":
        return HttpResponse.json({
          data: {
            nodes: (variables.ids ?? []).map((id) => {
              const title = this.titles.get(id);
              return title
                ? {
                    id,
                    content: { externalIds: { imdbId: title.imdbId } },
                  }
                : null;
            }),
          },
        });
      case "StremlistTitleByPath": {
        const imdbId = this.paths.get(variables.path ?? "");
        return HttpResponse.json({
          data: {
            urlV2: imdbId
              ? { node: { content: { externalIds: { imdbId } } } }
              : null,
          },
        });
      }
      default:
        return HttpResponse.json({
          errors: [{ message: `Unknown operation ${operation}` }],
        });
    }
  }
}
