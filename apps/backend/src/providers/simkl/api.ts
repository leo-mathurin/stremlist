import { ADDON_VERSION } from "@stremlist/shared/constants";
import { ensureOk, HttpError, providerFetch, RateLimiter } from "../http";
import { oauthClient } from "../oauth-app";
import { SourceUnavailableError } from "../types";

export const SIMKL_API = "https://api.simkl.com";
const APP_NAME = "stremlist";

// Simkl allows 10 GET and 1 POST per second for each user token. A POST over
// the limit gets the token blocked for a while, so writes are never retried.
const getLimiter = new RateLimiter(10, 1000);
export const postLimiter = new RateLimiter(1, 1000);

export const simklClient = oauthClient("SIMKL");
const { clientId } = simklClient;

/** Every Simkl call carries the app's client ID, name and version in the URL. */
function apiUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(path, SIMKL_API);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("client_id", clientId() ?? "");
  url.searchParams.set("app-name", APP_NAME);
  url.searchParams.set("app-version", ADDON_VERSION);
  return url.toString();
}

interface RequestOptions {
  method?: "GET" | "POST";
  token: string;
  params?: Record<string, string>;
  body?: unknown;
}

export async function simklRequest<T>(
  path: string,
  options: RequestOptions,
): Promise<T> {
  const id = clientId();
  if (!id) {
    throw new SourceUnavailableError("unavailable", "Simkl is not configured");
  }
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json",
    "simkl-api-key": id,
    Authorization: `Bearer ${options.token}`,
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const url = apiUrl(path, options.params);
  const response = await providerFetch(url, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    limiter: method === "GET" ? getLimiter : postLimiter,
    retryOn429: method === "GET",
  });
  if (response.status === 401) {
    // Expired or revoked grant: the user has to connect Simkl again.
    throw new SourceUnavailableError(
      "needs_connection",
      "Simkl rejected the access token",
    );
  }
  await ensureOk(response, url);
  return (await response.json()) as T;
}

export function isMaxItemsError(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.status === 400 &&
    error.body.includes("max_items")
  );
}
