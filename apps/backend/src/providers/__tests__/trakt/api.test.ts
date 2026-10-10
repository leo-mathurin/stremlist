import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { traktProvider } from "../../trakt";
import type { OAuthConfig } from "../../types";
import { ConnectionExpiredError, SourceUnavailableError } from "../../types";
import { clerks, listed } from "./fixtures";
import {
  calls,
  connection,
  expectReason,
  fetchEntries,
  json,
  required,
  resetTraktTest,
  restoreTraktTest,
  route,
  status,
} from "./harness";

vi.mock("../../http", async (importOriginal) => {
  const { httpModule } = await import("./mocks");
  return httpModule(await importOriginal());
});

beforeEach(resetTraktTest);
afterEach(restoreTraktTest);

describe("Trakt read errors", () => {
  it("a 401 on a public read means the Source list is private", async () => {
    route("GET /users/hidden/watchlist", status(401));
    await expectReason(fetchEntries("users/hidden/watchlist"), "private");
  });

  it("maps 404 to not_found", async () => {
    route("GET /users/sean/lists/gone/items", status(404));
    await expectReason(fetchEntries("users/sean/lists/gone"), "not_found");
  });

  it.each([420, 426])("maps %i to premium_only", async (code) => {
    route("GET /lists/42/items", status(code));
    await expectReason(fetchEntries("lists/42"), "premium_only");
  });

  it("other errors stay server errors", async () => {
    route("GET /lists/42/items", status(502));
    const error = await fetchEntries("lists/42").catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(SourceUnavailableError);
  });

  it("personal Source lists need a Connection", async () => {
    await expectReason(fetchEntries("me/watchlist"), "needs_connection");
    await expectReason(fetchEntries("me/up-next"), "needs_connection");
    expect(calls).toHaveLength(0);
  });

  it("retries a 401 once when the Connection gives a new token", async () => {
    route("GET /users/me/watchlist", (call) =>
      call.headers.get("Authorization") === "Bearer token-2"
        ? json([])
        : status(401),
    );
    const conn = connection(["token-1", "token-2"]);
    await expect(fetchEntries("me/watchlist", conn)).resolves.toEqual([]);
    expect(conn.getAccessToken).toHaveBeenCalledTimes(2);
  });

  it("a token that keeps being refused means needs_connection", async () => {
    route("GET /users/me/watchlist", status(401));
    await expectReason(
      fetchEntries("me/watchlist", connection()),
      "needs_connection",
    );
  });

  it("lets an expired Connection through, for the caller to ask for renewal", async () => {
    const conn = connection();
    conn.getAccessToken.mockRejectedValue(new ConnectionExpiredError("trakt"));
    await expect(fetchEntries("me/history", conn)).rejects.toBeInstanceOf(
      ConnectionExpiredError,
    );
  });

  it("a public Source list read with a refused token tries without it", async () => {
    route("GET /users/sean/watchlist", (call) =>
      call.headers.has("Authorization")
        ? status(401)
        : json([listed("movie", clerks, "2022-10-14T03:19:22.000Z", 1)]),
    );
    const entries = await fetchEntries("users/sean/watchlist", connection());
    expect(entries.map((e) => e.imdbId)).toEqual(["tt11128440"]);
  });

  it("a public Source list reads without a Connection that lost its token", async () => {
    route("GET /users/sean/watchlist", (call) =>
      call.headers.has("Authorization")
        ? status(500)
        : json([listed("movie", clerks, "2022-10-14T03:19:22.000Z", 1)]),
    );
    const conn = connection();
    conn.getAccessToken.mockRejectedValue(new ConnectionExpiredError("trakt"));

    const entries = await fetchEntries("users/sean/watchlist", conn);

    expect(entries.map((e) => e.imdbId)).toEqual(["tt11128440"]);
    expect(calls.every((call) => !call.headers.has("Authorization"))).toBe(
      true,
    );
  });

  it("a public chart reads without a Connection that lost its token", async () => {
    route("GET /movies/trending", (call) =>
      call.headers.has("Authorization") ? status(500) : json([]),
    );
    route("GET /shows/trending", (call) =>
      call.headers.has("Authorization") ? status(500) : json([]),
    );
    const conn = connection();
    conn.getAccessToken.mockRejectedValue(new ConnectionExpiredError("trakt"));

    await expect(fetchEntries("trending", conn)).resolves.toEqual([]);
  });

  it("a private Source list with a Connection that lost its token still needs renewal", async () => {
    const conn = connection();
    conn.getAccessToken.mockRejectedValue(new ConnectionExpiredError("trakt"));

    await expect(fetchEntries("me/watchlist", conn)).rejects.toBeInstanceOf(
      ConnectionExpiredError,
    );
    expect(calls).toHaveLength(0);
  });

  it("a private user stays private with a Connection that lost its token", async () => {
    route("GET /users/hidden/watchlist", status(401));
    const conn = connection();
    conn.getAccessToken.mockRejectedValue(new ConnectionExpiredError("trakt"));

    await expectReason(fetchEntries("users/hidden/watchlist", conn), "private");
  });

  it("reports a refused token when a public read works without it", async () => {
    route("GET /users/sean/watchlist", (call) =>
      call.headers.has("Authorization") ? status(401) : json([]),
    );
    const reportRefused = vi.fn(() => Promise.resolve());
    const conn = Object.assign(connection(), { reportRefused });

    await fetchEntries("users/sean/watchlist", conn);

    expect(reportRefused).toHaveBeenCalled();
  });

  it("does not report the token for a private user's list", async () => {
    route("GET /users/hidden/watchlist", status(401));
    const reportRefused = vi.fn(() => Promise.resolve());
    const conn = Object.assign(connection(), { reportRefused });

    await expectReason(fetchEntries("users/hidden/watchlist", conn), "private");
    expect(reportRefused).not.toHaveBeenCalled();
  });

  it("a private user stays private with a Connection", async () => {
    route("GET /users/hidden/watchlist", status(401));
    await expectReason(
      fetchEntries("users/hidden/watchlist", connection()),
      "private",
    );
  });

  it("an unknown ref is not_found", async () => {
    await expectReason(fetchEntries("users/x/favorites"), "not_found");
  });
});

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

describe("Trakt OAuth", () => {
  const oauth: OAuthConfig = required(traktProvider.oauth);

  it("uses the auth host and a public PKCE client", () => {
    expect(oauth.authorizeUrl).toBe("https://auth.trakt.tv/oauth/authorize");
    expect(oauth.tokenUrl).toBe("https://auth.trakt.tv/oauth/token");
    expect(oauth.clientId()).toBe("client-123");
    expect(oauth.clientSecret?.()).toBeUndefined();
    vi.stubEnv("TRAKT_CLIENT_SECRET", "secret-456");
    expect(oauth.clientSecret?.()).toBe("secret-456");
    vi.stubEnv("TRAKT_CLIENT_ID", "");
    expect(oauth.clientId()).toBeUndefined();
  });

  it("revokes a token on the auth host", async () => {
    route("POST /oauth/revoke", json({}));
    await oauth.revoke?.("token-9");
    expect(calls[0].url.host).toBe("auth.trakt.tv");
    expect(calls[0].body).toEqual({
      token: "token-9",
      client_id: "client-123",
    });
  });

  it("reads the username from the user settings", async () => {
    route("GET /users/settings", {
      user: { username: "Leo", ids: { slug: "leo" } },
      limits: {},
    });
    await expect(oauth.fetchUsername?.("token-9")).resolves.toBe("Leo");
    expect(calls[0].headers.get("Authorization")).toBe("Bearer token-9");
    expect(calls[0].headers.get("trakt-api-key")).toBe("client-123");
  });
});
