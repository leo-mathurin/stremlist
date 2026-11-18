import { http, HttpResponse } from "msw";
import { z } from "zod";
import type { SensCritiqueProduct } from "../../providers/senscritique";

export const SENSCRITIQUE_GRAPHQL = "https://apollo.senscritique.com/";

const UNIVERSES = { movie: 1, series: 4 } as const;

/** A SensCritique film (or series) as the GraphQL API sends it. */
export function senscritiqueProduct(
  id: number,
  overrides: Partial<SensCritiqueProduct> & { type?: "movie" | "series" } = {},
) {
  const { type = "movie", ...rest } = overrides;
  const product: SensCritiqueProduct = {
    id,
    title: `Film ${id}`,
    originalTitle: null,
    yearOfProduction: 2000,
    dateRelease: "2000-01-01",
    duration: 6000,
    universe: UNIVERSES[type],
    directors: [{ name: "Some Director" }],
    creators: [],
    providers: [],
    otherUserInfos: { id },
    ...rest,
  };
  return product;
}

const graphQLRequest = z.object({
  query: z.string(),
  variables: z.record(z.string(), z.unknown()).default({}),
});

/** One GraphQL request that the SensCritique API received. */
export interface SensCritiqueRequest {
  operation: string;
  variables: Record<string, unknown>;
}

type ProductSource = SensCritiqueProduct[] | "private";

function numberOf(value: unknown, fallback: number) {
  return typeof value === "number" ? value : fallback;
}

function page(
  products: SensCritiqueProduct[],
  variables: Record<string, unknown>,
) {
  const offset = numberOf(variables.offset, 0);
  const limit = numberOf(variables.limit, products.length);
  return products.slice(offset, offset + limit);
}

/**
 * The SensCritique GraphQL API in memory. It serves the lists, user
 * collections, charts and polls that a test stores, and keeps every request
 * it receives. `error` makes every request answer that GraphQL error.
 */
export class FakeSensCritique {
  /** The products of `lists/{id}`, or "private". */
  readonly lists = new Map<number, ProductSource>();
  /** The products by `${username}:${action}:${universe}`, for example `leo:WISH:movie`. */
  readonly collections = new Map<string, SensCritiqueProduct[]>();
  /** The users with a private profile. */
  readonly privateUsers = new Set<string>();
  /** The products by `${subtype}:${universe}`, for example `TOP_111:movie`. */
  readonly charts = new Map<string, SensCritiqueProduct[]>();
  /** The products of `polls/{id}`. */
  readonly polls = new Map<number, SensCritiqueProduct[]>();
  readonly requests: SensCritiqueRequest[] = [];
  error: string | null = null;

  /** The MSW handler of the GraphQL endpoint. */
  readonly handler = http.post(SENSCRITIQUE_GRAPHQL, ({ request }) =>
    this.answer(request),
  );

  reset() {
    this.lists.clear();
    this.collections.clear();
    this.privateUsers.clear();
    this.charts.clear();
    this.polls.clear();
    this.requests.length = 0;
    this.error = null;
  }

  /** The requests of this operation, for example `StremlistList`. */
  requestsOf(operation: string) {
    return this.requests.filter((request) => request.operation === operation);
  }

  private user(username: string) {
    const known = [...this.collections.keys()].some((key) =>
      key.startsWith(`${username}:`),
    );
    if (!known && !this.privateUsers.has(username)) return null;
    return {
      username,
      settings: { privacyProfile: this.privateUsers.has(username) },
    };
  }

  private data(operation: string, variables: Record<string, unknown>) {
    const id = numberOf(variables.id, 0);
    switch (operation) {
      case "StremlistUser":
        return { user: this.user(String(variables.username)) };
      case "StremlistCollection": {
        const username = String(variables.username);
        const user = this.user(username);
        const products =
          this.collections.get(
            `${username}:${String(variables.action)}:${String(variables.universe)}`,
          ) ?? [];
        return {
          user: user && {
            ...user,
            collection: {
              total: products.length,
              products: page(products, variables),
            },
          },
        };
      }
      case "StremlistListInfo":
      case "StremlistList": {
        const source = this.lists.get(id);
        if (source === undefined) return { userList: null };
        const products = source === "private" ? [] : source;
        return {
          userList: {
            id,
            label: `List ${id}`,
            isPrivate: source === "private",
            universe: UNIVERSES.movie,
            productsList: {
              total: products.length,
              items: page(products, variables).map((product) => ({ product })),
            },
          },
        };
      }
      case "StremlistChart":
        return {
          top: (
            this.charts.get(
              `${String(variables.subtype)}:${String(variables.universe)}`,
            ) ?? []
          ).slice(0, numberOf(variables.limit, Number.POSITIVE_INFINITY)),
        };
      case "StremlistPollInfo":
      case "StremlistPoll": {
        const products = this.polls.get(id);
        return {
          poll: products
            ? { id, label: `Poll ${id}`, universe: UNIVERSES.movie, products }
            : null,
        };
      }
      default:
        return null;
    }
  }

  async answer(request: Request) {
    const { query, variables } = graphQLRequest.parse(await request.json());
    const operation = /query (\w+)/.exec(query)?.[1] ?? "";
    this.requests.push({ operation, variables });
    if (this.error !== null) {
      return HttpResponse.json({
        data: null,
        errors: [{ message: this.error }],
      });
    }
    const data = this.data(operation, variables);
    if (data === null) {
      return HttpResponse.json({
        data: null,
        errors: [{ message: `Unknown operation ${operation}` }],
      });
    }
    return HttpResponse.json({ data });
  }
}
