import { ensureOk, HttpError, providerFetch, RateLimiter } from "../http";
import { oauthClient } from "../oauth-app";
import type { ConnectionAccess } from "../types";
import { connectionToken, SourceUnavailableError } from "../types";

export const TRAKT_API = "https://api.trakt.tv";
export const TRAKT_AUTH = "https://auth.trakt.tv";

/** Largest page size that Trakt accepts on most paginated endpoints. */
export const TRAKT_PAGE_SIZE = 250;

// Trakt allows 500 GETs per 5 minutes for all unauthenticated calls of the
// app together, and 500 per 5 minutes per user. These limiters only smooth
// bursts inside one instance (a big list, a prewarm); long freshness for
// public Source lists is what keeps the shared quota safe.
const publicReadLimiter = new RateLimiter(15, 10_000);
const connectedReadLimiter = new RateLimiter(40, 10_000);
// Trakt allows 1 write per second per user.
const writeLimiter = new RateLimiter(1, 1000);

export const { clientId: traktClientId } = oauthClient("TRAKT");

/** The string, or null when it is missing or empty. */
export function nonEmpty(value: string | null | undefined): string | null {
  if (!value) return null;
  return value;
}

export function traktHeaders(accessToken?: string): Record<string, string> {
  const clientId = traktClientId();
  if (!clientId) {
    throw new SourceUnavailableError("disabled", "Trakt is not configured");
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "trakt-api-key": clientId,
    "trakt-api-version": "2",
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}

export interface TraktReadOptions {
  /**
   * For Source lists that anyone may read (a user's public watchlist): when
   * the Connection's token is refused, try once without it, so a 401 tells
   * "private" apart from "the Connection is broken".
   */
  publicFallback?: boolean;
}

async function send(path: string, token?: string): Promise<Response> {
  return providerFetch(`${TRAKT_API}${path}`, {
    headers: traktHeaders(token),
    limiter: token ? connectedReadLimiter : publicReadLimiter,
  });
}

/**
 * The Connection's token, or null when a public read may go on without it: a
 * Connection that cannot give a token any more (refused refresh) must not
 * make Source lists that anyone may read fail.
 */
async function connectionTokenFor(
  connection: ConnectionAccess,
  options: TraktReadOptions,
): Promise<string | null> {
  try {
    return await connectionToken(connection);
  } catch (error) {
    if (
      options.publicFallback &&
      error instanceof SourceUnavailableError &&
      error.reason === "needs_connection"
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * One GET. Reads through the Connection when there is one (per-user quota),
 * otherwise with the client ID only. A 401 becomes a SourceUnavailableError:
 * "private" for public reads, "needs_connection" when the Connection's token
 * keeps being refused. Other non-2xx statuses throw HttpError.
 */
export async function traktGet(
  path: string,
  connection: ConnectionAccess | null,
  options: TraktReadOptions = {},
): Promise<Response> {
  const token = connection
    ? await connectionTokenFor(connection, options)
    : null;
  if (!connection || token === null) {
    const response = await send(path);
    if (response.status === 401) {
      throw new SourceUnavailableError("private", `Trakt ${path} is private`);
    }
    return checked(response, path);
  }

  let response = await send(path, token);
  if (response.status === 401) {
    // ConnectionAccess refreshes a token that is about to expire; a second
    // read only helps when that gave us a new one.
    const renewed = await connectionToken(connection);
    if (renewed !== token) response = await send(path, renewed);
  }
  if (response.status === 401 && options.publicFallback) {
    response = await send(path);
    if (response.status === 401) {
      throw new SourceUnavailableError("private", `Trakt ${path} is private`);
    }
    // Readable without the token but refused with it: the Connection is
    // broken even though this public read works.
    await connection.reportRefused?.();
  }
  if (response.status === 401) {
    throw new SourceUnavailableError(
      "needs_connection",
      "Trakt refused the Connection's token",
    );
  }
  return checked(response, path);
}

function checked(response: Response, path: string): Promise<Response> {
  return ensureOk(response, `${TRAKT_API}${path}`);
}

/** GET and parse JSON. A 204 (Trakt's answer for some missing records) is null. */
export async function traktGetJson<T>(
  path: string,
  connection: ConnectionAccess | null,
  options: TraktReadOptions = {},
): Promise<T | null> {
  const response = await traktGet(path, connection, options);
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : null;
}

function withQuery(path: string, params: Record<string, string>): string {
  const [base, query] = path.split("?", 2);
  const search = new URLSearchParams(query);
  for (const [key, value] of Object.entries(params)) search.set(key, value);
  return `${base}?${search.toString()}`;
}

export interface PaginateOptions extends TraktReadOptions {
  pageSize?: number;
  maxItems: number;
}

/**
 * Every page of a paginated endpoint, up to `maxItems`. Pagination must be
 * explicit: without `limit` many endpoints return only their first 10 items.
 * Endpoints where pagination is optional answer without the page headers;
 * their single response is then the whole set.
 */
export async function traktGetAll<T>(
  path: string,
  connection: ConnectionAccess | null,
  options: PaginateOptions,
): Promise<T[]> {
  const pageSize = options.pageSize ?? TRAKT_PAGE_SIZE;
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const response = await traktGet(
      withQuery(path, { page: String(page), limit: String(pageSize) }),
      connection,
      options,
    );
    if (response.status === 204) break;
    const data = (await response.json()) as T[];
    if (!Array.isArray(data) || data.length === 0) break;
    items.push(...data);
    if (items.length >= options.maxItems)
      return items.slice(0, options.maxItems);
    const pageCount = Number(response.headers.get("X-Pagination-Page-Count"));
    if (!Number.isFinite(pageCount) || page >= pageCount) break;
  }
  return items;
}

/** Map an HttpError from Trakt to the Source list state it means. */
export function toSourceError(error: unknown): unknown {
  if (!(error instanceof HttpError)) return error;
  switch (error.status) {
    case 404:
      return new SourceUnavailableError("not_found", error.message);
    // 420: account limit exceeded; 426: VIP only.
    case 420:
    case 426:
      return new SourceUnavailableError("premium_only", error.message);
    default:
      return error;
  }
}

export class TraktWriteError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TraktWriteError";
    this.status = status;
  }
}

/** POST a change through the Connection (1 write per second). */
export async function traktPost<T>(
  path: string,
  connection: ConnectionAccess,
  body: unknown,
): Promise<T | null> {
  const token = await connection.getAccessToken();
  const response = await providerFetch(`${TRAKT_API}${path}`, {
    method: "POST",
    headers: traktHeaders(token),
    body: JSON.stringify(body),
    limiter: writeLimiter,
  });
  if (!response.ok) {
    const reason =
      response.status === 420
        ? "the Trakt account limit is reached"
        : response.status === 426
          ? "this needs Trakt VIP"
          : `HTTP ${response.status}`;
    throw new TraktWriteError(
      response.status,
      `Trakt ${path} failed: ${reason}`,
    );
  }
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : null;
}
