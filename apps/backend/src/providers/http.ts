import { ADDON_VERSION } from "@stremlist/shared/constants";

/** Identifying User-Agent for Provider APIs (Trakt and Simkl require one). */
export const STREMLIST_USER_AGENT = `Stremlist/${ADDON_VERSION} (+https://stremlist.com)`;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_MS = 10_000;

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, url: string) {
    super(`HTTP ${status} from ${new URL(url).host}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * A small in-process limiter: at most `limit` requests per `windowMs`, per
 * serverless instance. It protects Provider quotas from bursts (a prewarm of
 * many Lists, a big paginated list). It is not a global quota.
 */
export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly timestamps: number[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  acquire(): Promise<void> {
    const next = this.queue.then(async () => {
      for (;;) {
        const now = Date.now();
        while (
          this.timestamps.length > 0 &&
          now - this.timestamps[0] >= this.windowMs
        ) {
          this.timestamps.shift();
        }
        if (this.timestamps.length < this.limit) {
          this.timestamps.push(now);
          return;
        }
        await sleep(this.windowMs - (now - this.timestamps[0]) + 1);
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ProviderFetchOptions extends RequestInit {
  limiter?: RateLimiter;
  timeoutMs?: number;
  /** Retry once after a 429 whose Retry-After is short enough. */
  retryOn429?: boolean;
}

/**
 * fetch() for Provider APIs: identifying User-Agent, timeout, optional rate
 * limiter, and one retry on 429 when the Provider asks for a short wait.
 */
export async function providerFetch(
  url: string,
  options: ProviderFetchOptions = {},
): Promise<Response> {
  const {
    limiter,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryOn429 = true,
    ...init
  } = options;
  const headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", STREMLIST_USER_AGENT);
  }

  for (let attempt = 0; ; attempt++) {
    await limiter?.acquire();
    const response = await fetch(url, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 429 || !retryOn429 || attempt > 0) {
      return response;
    }
    const retryAfterMs = Number(response.headers.get("Retry-After")) * 1000;
    if (!Number.isFinite(retryAfterMs) || retryAfterMs > MAX_RETRY_AFTER_MS) {
      return response;
    }
    await sleep(Math.max(retryAfterMs, 500));
  }
}

/** The response when it is 2xx; otherwise an HttpError with its body. */
export async function ensureOk(
  response: Response,
  url: string,
): Promise<Response> {
  if (!response.ok) {
    throw new HttpError(
      response.status,
      await response.text().catch(() => ""),
      url,
    );
  }
  return response;
}

/** providerFetch() that parses JSON and throws HttpError on non-2xx. */
// The caller names the response shape; the body is not validated.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export async function providerFetchJson<T>(
  url: string,
  options: ProviderFetchOptions = {},
): Promise<{ data: T; response: Response }> {
  const response = await ensureOk(await providerFetch(url, options), url);
  return { data: (await response.json()) as T, response };
}

export interface GraphQLResponse<T> {
  data?: T | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}

/**
 * POST a GraphQL query. Throws HttpError on non-2xx. GraphQL errors stay in
 * the result, because some APIs use them for expected states (a private or
 * deleted list) that the caller maps to a reason.
 */
export async function graphqlRequest<T>(
  url: string,
  query: string,
  variables: Record<string, unknown>,
  options: ProviderFetchOptions = {},
): Promise<GraphQLResponse<T>> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  const { data } = await providerFetchJson<GraphQLResponse<T>>(url, {
    ...options,
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  return data;
}
