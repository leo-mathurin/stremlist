/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import type { ProviderId } from "@stremlist/shared/providers";
import { PROVIDER_IDS } from "@stremlist/shared/providers";
import { describe, it, expect, beforeEach, vi } from "vitest";

import app from "../index.js";
import { SourceUnavailableError } from "../providers/types";

vi.mock("../lib/background", async () => {
  return (await import("./helpers/config-api-mocks.js")).backgroundMocks;
});
vi.mock("../services/list-prewarm", async () => {
  return (await import("./helpers/config-api-mocks.js")).prewarmMocks;
});

vi.mock("../lib/supabase", async () => {
  const { supabase } = await import("./helpers/mock-supabase.js");
  const { rpcMocks } = await import("./helpers/config-api-mocks.js");
  return { supabase: { ...supabase, rpc: rpcMocks.rpc } };
});

vi.mock("../services/list-cache", async () => {
  return await import("./helpers/mock-list-cache.js");
});

vi.mock("../providers/registry", async () => {
  return await import("./helpers/mock-registry.js");
});

vi.mock("../lib/r2", async () => {
  return await import("./helpers/mock-r2.js");
});
vi.mock("../lib/resend", () => ({
  resend: { contacts: { create: vi.fn() } },
}));

import * as scraper from "../services/imdb-scraper";
import {
  legacyAccountId,
  OWNER,
  postJson,
  resetConfigTest,
} from "./helpers/config-api.js";
import { seedAccount, seedConnection } from "./helpers/fixtures.js";
import { fakeAdapter, useFakeProvider } from "./helpers/mock-registry.js";

beforeEach(resetConfigTest);

// ---------------------------------------------------------------------------
// Link resolution
// ---------------------------------------------------------------------------

describe("POST /links/resolve", () => {
  function resolve(input: string, accountKey?: string) {
    return postJson("/links/resolve", { input, accountKey });
  }

  it("says when no Provider recognizes the input", async () => {
    const res = await resolve("not a link");
    expect(await res.json()).toEqual({ ok: false, reason: "unrecognized" });
  });

  it("says Letterboxd is coming soon", async () => {
    const res = await resolve("https://letterboxd.com/leo/watchlist/");
    expect(await res.json()).toEqual({
      ok: false,
      reason: "coming_soon",
      provider: "letterboxd",
    });
  });

  it("says when a Provider is turned off", async () => {
    const validateSource = vi.fn();
    useFakeProvider(fakeAdapter("trakt", { validateSource }));
    process.env.DISABLED_PROVIDERS = "imdb, trakt";

    const res = await resolve("https://trakt.tv/users/leo/watchlist");

    expect(await res.json()).toEqual({
      ok: false,
      reason: "disabled",
      provider: "trakt",
    });
    expect(validateSource).not.toHaveBeenCalled();
  });

  it("asks for a Connection when the list needs one", async () => {
    const res = await resolve("https://mdblist.com/lists/leo/top-movies");
    expect(await res.json()).toEqual({
      ok: false,
      reason: "needs_connection",
      provider: "mdblist",
    });
  });

  it("never uses a Connection for a Legacy alias", async () => {
    seedConnection(legacyAccountId, "mdblist");
    const res = await resolve(
      "https://mdblist.com/lists/leo/top-movies",
      OWNER,
    );
    expect((await res.json()).reason).toBe("needs_connection");
  });

  it("asks for a Connection again when the Connection expired", async () => {
    const validateSource = vi.fn(
      async (
        _ref: string,
        ctx: { connection: { getAccessToken(): Promise<string> } | null },
      ) => {
        await ctx.connection?.getAccessToken();
        return { ok: true as const, ref: "lists/leo/top-movies" };
      },
    );
    useFakeProvider(fakeAdapter("mdblist", { validateSource }));
    const account = seedAccount();
    // Expired, and no refresh token to renew it.
    seedConnection(account.id, "mdblist", {
      expiresAt: new Date(Date.now() - 60_000),
      refreshToken: null,
    });

    const res = await resolve(
      "https://mdblist.com/lists/leo/top-movies",
      account.id,
    );

    expect(await res.json()).toEqual({
      ok: false,
      reason: "needs_connection",
      provider: "mdblist",
    });
  });

  it("reports why a Provider refuses the Source list", async () => {
    const validateSource = vi.fn(() =>
      Promise.reject(
        new SourceUnavailableError(
          "private",
          "Trakt list leo/watchlist is private",
        ),
      ),
    );
    useFakeProvider(fakeAdapter("trakt", { validateSource }));

    const res = await resolve("https://trakt.tv/users/leo/watchlist");

    expect(await res.json()).toEqual({
      ok: false,
      reason: "private",
      provider: "trakt",
    });
  });

  it("validates through the Connection of a private Account", async () => {
    const validateSource = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        ref: "lists/leo/top-movies",
        suggestedTitle: "Top movies",
      }),
    );
    useFakeProvider(fakeAdapter("mdblist", { validateSource }));
    const account = seedAccount();
    seedConnection(account.id, "mdblist", { username: "leo" });

    const res = await resolve(
      "https://mdblist.com/lists/leo/top-movies",
      account.id,
    );

    expect(await res.json()).toEqual({
      ok: true,
      provider: "mdblist",
      sourceRef: "lists/leo/top-movies",
      kind: "list",
      requiresConnection: true,
      suggestedTitle: "Top movies",
      defaultDisplayMode: null,
    });
    expect(validateSource).toHaveBeenCalledWith("lists/leo/top-movies", {
      connection: expect.objectContaining({
        provider: "mdblist",
        username: "leo",
      }),
    });
  });

  it("resolves an IMDb watchlist link (p. handle) to its user ID", async () => {
    const validate = vi
      .spyOn(scraper, "validateImdbWatchlist")
      .mockResolvedValue({ valid: true, userId: OWNER });

    const res = await resolve("https://www.imdb.com/user/p.leo123/watchlist");

    expect(await res.json()).toEqual({
      ok: true,
      provider: "imdb",
      sourceRef: OWNER,
      kind: "watchlist",
      requiresConnection: false,
      suggestedTitle: null,
      defaultDisplayMode: null,
    });
    expect(validate).toHaveBeenCalledWith("p.leo123");
  });

  it("reports a private IMDb watchlist", async () => {
    vi.spyOn(scraper, "validateImdbWatchlist").mockResolvedValue({
      valid: false,
      reason: "private",
    });

    const res = await resolve(OWNER);

    expect(await res.json()).toEqual({
      ok: false,
      reason: "private",
      provider: "imdb",
    });
  });

  it("resolves an IMDb chart without a network call", async () => {
    const res = await resolve("imdb:top-rated-movies");

    expect(await res.json()).toMatchObject({
      ok: true,
      provider: "imdb",
      sourceRef: "imdb:top-rated-movies",
      kind: "chart",
      suggestedTitle: "Top 250 Movies",
      defaultDisplayMode: "movie",
    });
  });

  it("answers unavailable when validation throws", async () => {
    vi.spyOn(scraper, "validateImdbList").mockRejectedValue(
      new Error("socket hang up"),
    );

    const res = await resolve("https://www.imdb.com/list/ls123456789/");

    expect(await res.json()).toEqual({
      ok: false,
      reason: "unavailable",
      provider: "imdb",
    });
  });
});

// ---------------------------------------------------------------------------
// Provider status
// ---------------------------------------------------------------------------

describe("GET /providers", () => {
  it("lists every Provider with its kill switch and OAuth status", async () => {
    useFakeProvider(
      fakeAdapter("trakt", {
        oauth: {
          authorizeUrl: "https://trakt.example/oauth/authorize",
          tokenUrl: "https://trakt.example/oauth/token",
          clientId: () => "client-id",
        },
      }),
    );
    useFakeProvider(
      fakeAdapter("simkl", {
        oauth: {
          authorizeUrl: "https://simkl.example/oauth/authorize",
          tokenUrl: "https://simkl.example/oauth/token",
          clientId: () => undefined,
        },
      }),
    );
    process.env.DISABLED_PROVIDERS = "justwatch";

    const res = await app.request("/providers");
    const { providers } = (await res.json()) as {
      providers: { id: ProviderId; enabled: boolean; connectable: boolean }[];
    };

    expect(providers.map((provider) => provider.id)).toEqual([...PROVIDER_IDS]);
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    expect(byId.get("trakt")).toEqual({
      id: "trakt",
      enabled: true,
      connectable: true,
    });
    expect(byId.get("simkl")?.connectable).toBe(false);
    expect(byId.get("imdb")?.connectable).toBe(false);
    expect(byId.get("justwatch")?.enabled).toBe(false);
  });
});
