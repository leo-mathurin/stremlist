/**
 * Readers for the JSON that the routes answer. Each one parses the body with
 * a schema, so a test reads typed fields instead of asserting a type. Object
 * schemas keep unknown keys, so `toEqual` still sees the whole body.
 */
import type { Json } from "@stremlist/shared/database";
import type {
  StremioManifest,
  StremioMeta,
  StremioStream,
} from "@stremlist/shared/stremio.types";
import { z } from "zod";

/** The body of `res`, parsed with `schema`. */
export async function readJson<T>(
  res: Response,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T> {
  return schema.parse(await res.json());
}

/** `text` as JSON, parsed with `schema`. */
export function parseJson<T>(
  text: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): T {
  return schema.parse(JSON.parse(text));
}

/**
 * `schema`, but a parse gives back the value itself instead of a copy, so
 * its key order stays the same (for code that compares JSON text).
 */
export function unchanged<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): z.ZodType<T, z.ZodTypeDef, unknown> {
  return z.custom<T>((value) => schema.safeParse(value).success);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` when it is a string, or a clear failure. */
export function mustString(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`Expected ${what} string`);
  return value;
}

/** Any JSON value except null, like a NOT NULL jsonb column. */
export const jsonObject: z.ZodType<NonNullable<Json>> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(json),
    z.record(json.optional()),
  ]),
);

/** Any JSON value, like a jsonb column or argument. */
export const json: z.ZodType<Json> = z.lazy(() => jsonObject.nullable());

export const errorBody = z.object({ error: z.string() }).passthrough();

export const accountIdBody = z.object({ accountId: z.string() }).passthrough();

const titleType = z.enum(["movie", "series"]);

const stremioMeta = z
  .object({
    id: z.string(),
    name: z.string(),
    poster: z.string().nullable(),
    posterShape: z.enum(["poster", "square", "landscape"]),
    type: titleType,
    genres: z.array(z.string()),
    description: z.string(),
    imdbRating: z.string().optional(),
    releaseInfo: z.string().optional(),
    director: z.array(z.string()).optional(),
    cast: z.array(z.string()).optional(),
    runtime: z.string().optional(),
    released: z.string().optional(),
  })
  .passthrough() satisfies z.ZodType<StremioMeta>;

export const metasBody = z
  .object({ metas: z.array(stremioMeta) })
  .passthrough();

export const metaBody = z
  .object({ meta: stremioMeta.nullable() })
  .passthrough();

export const stremioManifest = z
  .object({
    id: z.string(),
    version: z.string(),
    name: z.string(),
    description: z.string(),
    resources: z.array(
      z.union([
        z.string(),
        z
          .object({
            name: z.string(),
            types: z.array(z.string()),
            idPrefixes: z.array(z.string()).optional(),
          })
          .passthrough(),
      ]),
    ),
    types: z.array(z.string()),
    catalogs: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          type: titleType,
          extra: z
            .array(
              z
                .object({
                  name: z.enum(["skip", "genre", "search"]),
                  isRequired: z.boolean().optional(),
                  options: z.array(z.string()).optional(),
                  optionsLimit: z.number().optional(),
                })
                .passthrough(),
            )
            .optional(),
        })
        .passthrough(),
    ),
    logo: z.string(),
    behaviorHints: z
      .object({
        configurable: z.boolean(),
        configurationRequired: z.boolean(),
      })
      .passthrough(),
    config: z
      .array(
        z
          .object({
            key: z.string(),
            type: z.enum(["select", "text", "password", "checkbox"]),
            title: z.string(),
            options: z.array(z.string()).optional(),
            default: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    selfUrl: z.string().optional(),
  })
  .passthrough() satisfies z.ZodType<StremioManifest>;

export const streamsBody = z
  .object({
    streams: z.array(
      z
        .object({
          name: z.string(),
          title: z.string().optional(),
          description: z.string().optional(),
          externalUrl: z.string().optional(),
          url: z.string().optional(),
          behaviorHints: z
            .object({
              notWebReady: z.boolean().optional(),
              bingeGroup: z.string().optional(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough() satisfies z.ZodType<StremioStream>,
    ),
    cacheMaxAge: z.number(),
  })
  .passthrough();

const configList = z
  .object({
    id: z.string(),
    provider: z.string(),
    sourceRef: z.string(),
    catalogTitle: z.string(),
    sortOption: z.string(),
    position: z.number(),
  })
  .passthrough();

/** The fields of the configuration (AccountConfigResponse) that tests read. */
export const configBody = z
  .object({
    access: z.enum(["private", "legacy"]),
    accountId: z.string().nullable(),
    rpdbApiKey: z.string().nullable(),
    lists: z.array(configList),
    connections: z.array(
      z
        .object({ provider: z.string(), username: z.string().nullable() })
        .passthrough(),
    ),
    newTitles: z
      .object({
        enabled: z.boolean(),
        summary: z
          .object({
            detected: z.number(),
            latestDetectedAt: z.string().nullable(),
            waitingLists: z.number(),
          })
          .passthrough()
          .nullable(),
      })
      .passthrough(),
    lastFetchedAt: z.string(),
    stremio: z
      .object({ email: z.string().nullable() })
      .passthrough()
      .nullable(),
  })
  .passthrough();

/** What POST /accounts answers. */
export const createdAccountBody = z
  .object({
    ok: z.boolean(),
    accountId: z.string(),
    lists: z.array(configList),
  })
  .passthrough();

/** The sync status of an Account's Lists (AccountSyncSnapshot). */
export const syncSnapshotBody = z
  .object({
    syncStatus: z.record(z.array(z.unknown())),
    connections: z.array(z.unknown()),
    readQueue: z
      .record(
        z.object({ provider: z.string(), readyAt: z.string() }).passthrough(),
      )
      .optional(),
  })
  .passthrough();

/** What POST /:accountKey/refresh answers. */
export const refreshBody = z
  .object({
    lastFetchedAt: z.string(),
    refreshed: z.number(),
    failed: z.number(),
    total: z.number(),
    throttled: z.boolean().optional(),
  })
  .passthrough();
