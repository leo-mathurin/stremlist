import { ADDON_VERSION } from "@stremlist/shared/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simklProvider } from "../../simkl";
import {
  calls,
  ctx,
  json,
  resetSimklTest,
  restoreSimklTest,
  routes,
} from "./harness";
import { limiters } from "./mocks";

vi.mock("../../../lib/r2", async () => {
  return (await import("./mocks")).r2Module;
});
vi.mock("../../http", async (importOriginal) => {
  const { httpModule } = await import("./mocks");
  return httpModule(await importOriginal());
});

beforeEach(resetSimklTest);
afterEach(restoreSimklTest);

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

  it("stay under 10 GET and 1 POST per second", () => {
    expect(limiters).toContainEqual([10, 1000]);
    expect(limiters).toContainEqual([1, 1000]);
  });

  it("treat a rejected token as a lost Connection", async () => {
    routes["GET /sync/activities"] = () =>
      json({ error: "user_token_failed" }, 401);
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
    routes["GET /users/settings"] = () => ({
      user: { name: "leo-simkl", joined_at: "2018-01-15T00:00:00Z" },
      account: { id: 12345, timezone: "Europe/Paris", type: "free" },
    });
    await expect(oauth.fetchUsername?.("simkl_at_new")).resolves.toBe(
      "leo-simkl",
    );
    expect(calls[0].headers.get("Authorization")).toBe("Bearer simkl_at_new");
  });

  it("revokes the grant with the client credentials", async () => {
    routes["POST /oauth2/revoke"] = () => ({});
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
