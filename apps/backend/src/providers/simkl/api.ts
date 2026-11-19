import { ADDON_VERSION } from "@stremlist/shared/constants";
import type { z } from "zod";
import {
  HttpError,
  limitersByKey,
  providerFetchJson,
  RateLimiter,
} from "../http";
import { oauthClient } from "../oauth-app";
import { SourceUnavailableError } from "../types";

export const SIMKL_API = "https://api.simkl.com";
const APP_NAME = "stremlist";

/**
 * With AUTH V2, Simkl allows 10 GET and 1 POST per second for each user and
 * has no app-wide cap. Every call carries the user's token, so the limiters
 * go by token (a refresh gives a new one about once a week): one user's
 * backlog never delays another user's reads. A POST over the limit gets the
 * token blocked for a while, so writes are never retried.
 */
export const simklLimiters = limitersByKey(() => ({
  get: new RateLimiter(10, 1000),
  post: new RateLimiter(1, 1000),
}));

export const simklClient = oauthClient("SIMKL");

interface RequestOptions {
  signal?: AbortSignal;
  method?: "GET" | "POST";
  token: string;
  params?: Record<string, string>;
  body?: unknown;
}

/**
 * The app's client ID, name and version, which Simkl wants on every call,
 * API or CDN file.
 */
export function simklAppQuery() {
  const id = simklClient.clientId();
  if (!id) {
    throw new SourceUnavailableError("unavailable", "Simkl is not configured");
  }
  return { client_id: id, "app-name": APP_NAME, "app-version": ADDON_VERSION };
}

export async function simklRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions,
) {
  const app = simklAppQuery();
  const method = options.method ?? "GET";
  try {
    const { data } = await providerFetchJson(
      new URL(path, SIMKL_API).toString(),
      {
        method,
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
          : undefined,
        query: { ...options.params, ...app },
        headers: { Accept: "application/json", "simkl-api-key": app.client_id },
        bearer: options.token,
        json: options.body,
        limiter: simklLimiters(options.token)[
          method === "GET" ? "get" : "post"
        ],
        retryOn429: method === "GET",
      },
    );
    return schema.parse(data);
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      throw new SourceUnavailableError(
        "needs_connection",
        "Simkl rejected the access token",
      );
    }
    throw error;
  }
}

export function isMaxItemsError(error: unknown) {
  return (
    error instanceof HttpError &&
    error.status === 400 &&
    error.body.includes("max_items")
  );
}
