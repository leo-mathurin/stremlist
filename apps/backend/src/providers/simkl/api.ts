import { ADDON_VERSION } from "@stremlist/shared/constants";
import { HttpError, providerFetchJson, RateLimiter } from "../http";
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
  try {
    const { data } = await providerFetchJson<T>(
      new URL(path, SIMKL_API).toString(),
      {
        method,
        // Every Simkl call carries the app's client ID, name and version.
        query: {
          ...options.params,
          client_id: id,
          "app-name": APP_NAME,
          "app-version": ADDON_VERSION,
        },
        headers: { Accept: "application/json", "simkl-api-key": id },
        bearer: options.token,
        json: options.body,
        limiter: method === "GET" ? getLimiter : postLimiter,
        retryOn429: method === "GET",
      },
    );
    return data;
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      // Expired or revoked grant: the user has to connect Simkl again.
      throw new SourceUnavailableError(
        "needs_connection",
        "Simkl rejected the access token",
      );
    }
    throw error;
  }
}

export function isMaxItemsError(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.status === 400 &&
    error.body.includes("max_items")
  );
}
