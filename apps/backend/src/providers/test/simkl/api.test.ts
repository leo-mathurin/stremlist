import { ADDON_VERSION } from "@stremlist/shared/constants";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { useMswServer } from "../../../test/helpers/msw.test-utils";
import { simklProvider } from "../../simkl";
import { simklLimiters } from "../../simkl/api";
import {
  calls,
  ctx,
  json,
  resetSimklTest,
  restoreStubs,
  routes,
} from "./harness";

const server = useMswServer();

beforeEach(() => resetSimklTest(server));
afterEach(restoreStubs);

describe("simkl requests", () => {
  it("identify the app on every call", async () => {
    await simklProvider.fetchSource("me/plantowatch", ctx());

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.origin).toBe("https://api.simkl.com");
      expect(call.url.searchParams.get("client_id")).toBe("client-123");
      expect(call.url.searchParams.get("app-name")).toBe("stremlist");
      expect(call.url.searchParams.get("app-version")).toBe(ADDON_VERSION);
      expect(call.headers.get("simkl-api-key")).toBe("client-123");
      expect(call.headers.get("Authorization")).toBe("Bearer simkl_at_test");
      expect(call.headers.get("User-Agent")).toMatch(/^Stremlist\//);
    }
  });

  it("stay under 10 GET and 1 POST per second for each user token", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    const first = simklLimiters("simkl_at_first");
    expect(simklLimiters("simkl_at_first")).toBe(first);
    const second = simklLimiters("simkl_at_second");
    expect(second).not.toBe(first);

    let gets = 0;
    let posts = 0;
    const waiting = [
      ...Array.from({ length: 11 }, () =>
        first.get.acquire().then(() => gets++),
      ),
      ...Array.from({ length: 2 }, () =>
        first.post.acquire().then(() => posts++),
      ),
    ];
    await vi.advanceTimersByTimeAsync(0);
    expect([gets, posts]).toEqual([10, 1]);
    let otherToken = false;
    void second.post.acquire().then(() => (otherToken = true));
    await vi.advanceTimersByTimeAsync(999);
    expect([gets, posts, otherToken]).toEqual([10, 1, true]);
    await vi.advanceTimersByTimeAsync(2);
    expect([gets, posts]).toEqual([11, 2]);
    await Promise.all(waiting);
  });

  it("treat a rejected token as a lost Connection", async () => {
    routes.set("GET /sync/activities", () =>
      json({ error: "user_token_failed" }, 401),
    );
    await expect(
      simklProvider.fetchSource("me/plantowatch", ctx()),
    ).rejects.toMatchObject({ reason: "needs_connection" });
  });
});

describe("simkl oauth", () => {
  const oauth = simklProvider.oauth;
  if (!oauth) throw new Error("Simkl must use OAuth");

  it("uses AUTH V2 with explicit write scope", () => {
    expect(oauth.authorizeUrl).toBe("https://simkl.com/oauth2/authorize");
    expect(oauth.tokenUrl).toBe("https://api.simkl.com/oauth2/token");
    expect(oauth.scopes).toEqual(["media:read", "media:write"]);
    expect(oauth.clientId()).toBe("client-123");
    expect(oauth.clientSecret?.()).toBe("secret-456");
    process.env.SIMKL_CLIENT_ID = " ";
    expect(oauth.clientId()).toBeUndefined();
  });

  it("reads the username from the user settings", async () => {
    routes.set("GET /users/settings", () => ({
      user: { name: "leo-simkl", joined_at: "2018-01-15T00:00:00Z" },
      account: { id: 12345, timezone: "Europe/Paris", type: "free" },
    }));
    await expect(oauth.fetchUsername?.("simkl_at_new")).resolves.toBe(
      "leo-simkl",
    );
    expect(calls[0].headers.get("Authorization")).toBe("Bearer simkl_at_new");
  });

  it("revokes the grant with the client credentials", async () => {
    routes.set("POST /oauth2/revoke", () => ({}));
    await oauth.revoke?.("simkl_at_old");
    const call = calls[0];
    expect(call.headers.get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(Object.fromEntries(new URLSearchParams(call.body))).toEqual({
      client_id: "client-123",
      client_secret: "secret-456",
      token: "simkl_at_old",
    });
  });
});
