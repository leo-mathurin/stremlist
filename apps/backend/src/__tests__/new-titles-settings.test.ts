import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/supabase", async () => {
  return await import("./helpers/mock-supabase.js");
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
vi.mock("../lib/resend", () => import("../__tests__/helpers/mock-resend"));

import app from "../index.js";
import { saveConnection } from "../services/connections";
import { disconnectProvider } from "../services/lists";
import {
  LIST_IDS,
  movie,
  seedConnection,
  seedLegacyAccount,
  seedList,
} from "./helpers/fixtures.js";
import { fakeAdapter, useFakeProvider } from "./helpers/mock-registry.js";
import { db } from "./helpers/mock-supabase.js";
import {
  accountId,
  detectionRows,
  entry,
  newTitles,
  resetNewTitlesTest,
  restoreNewTitlesTest,
  seedHistory,
  seedNewTitlesAccount,
  setAccountId,
  summary,
  syncRows,
} from "./helpers/new-titles.js";

beforeEach(resetNewTitlesTest);
afterEach(restoreNewTitlesTest);

describe("settings", () => {
  const LIST = {
    provider: "imdb",
    sourceRef: "imdb:top-rated-movies",
    sortOption: "added_at-asc",
  };

  it("saves the setting with the configuration", async () => {
    seedNewTitlesAccount(false);

    const res = await app.request(`/${accountId}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lists: [LIST], newTitles: { enabled: true } }),
    });

    expect(res.status).toBe(200);
    expect((await summary()).enabled).toBe(true);
  });

  it("keeps the setting when a save does not send it", async () => {
    seedNewTitlesAccount(true);

    await app.request(`/${accountId}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lists: [LIST] }),
    });

    expect((await summary()).enabled).toBe(true);
  });

  it("keeps the setting when a Legacy alias install gets its private copy", async () => {
    const legacy = seedLegacyAccount("ur7654321", { new_titles_catalog: true });
    seedList(legacy.id, { id: LIST_IDS[0], source_ref: "ur7654321" });

    const res = await app.request("/ur7654321/upgrade", { method: "POST" });
    setAccountId(((await res.json()) as { accountId: string }).accountId);

    expect(res.status).toBe(200);
    expect((await summary()).enabled).toBe(true);
  });

  it("turns it on for a new Account", async () => {
    const res = await app.request("/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lists: [LIST], newTitles: { enabled: true } }),
    });
    setAccountId(((await res.json()) as { accountId: string }).accountId);

    expect((await summary()).enabled).toBe(true);
  });
});

describe("Connection cleanup", () => {
  it("keeps only the current Connection user's history and public Source lists", async () => {
    seedNewTitlesAccount();
    // leo was connected; a refresh already wrote a Baseline for sam.
    seedConnection(accountId, "trakt", { username: "leo" });
    ["me/history", "me/collection", "users/leo/watchlist"].forEach(
      (sourceRef, position) =>
        seedList(accountId, {
          id: LIST_IDS[position],
          provider: "trakt",
          source_ref: sourceRef,
          position,
        }),
    );
    seedHistory("trakt", "me/history", "tt0000001", "leo");
    seedHistory("trakt", "me/collection", "tt0000002", "sam");
    seedHistory("trakt", "users/leo/watchlist", "tt0000003");
    const counts = async () => {
      const { summary: found } = await summary();
      return [found?.detected, found?.waitingLists];
    };
    // The history of sam is not leo's: that List waits for a Baseline.
    expect(await counts()).toEqual([2, 1]);

    // sam connects: the history of leo no longer counts.
    await saveConnection(
      accountId,
      "trakt",
      {
        accessToken: "access-1",
        refreshToken: null,
        expiresAt: null,
        scope: null,
      },
      "sam",
      "https://api.stremlist.test/oauth/trakt/callback",
    );
    expect(await counts()).toEqual([2, 1]);

    // After a disconnect, only the public Source list keeps its history.
    await disconnectProvider(accountId, "trakt");
    expect(db.getTable("connections")).toEqual([]);
    expect(syncRows().map((row) => row.source_ref)).toEqual([
      "users/leo/watchlist",
    ]);
    expect(detectionRows().map((row) => row.source_ref)).toEqual([
      "users/leo/watchlist",
    ]);
    expect(await counts()).toEqual([1, 2]);
  });

  it("forgets the previous user's history before a new Connection reads again", async () => {
    seedNewTitlesAccount();
    seedConnection(accountId, "trakt", { username: "leo" });
    seedList(accountId, {
      id: LIST_IDS[0],
      provider: "trakt",
      source_ref: "me/history",
    });
    seedHistory("trakt", "me/history", "tt0000001", "leo");
    useFakeProvider(
      fakeAdapter("trakt", {
        entries: [entry(movie("tt0000002"))],
        oauth: {
          authorizeUrl: "https://trakt.example/oauth/authorize",
          tokenUrl: "https://api.trakt.example/oauth/token",
          clientId: () => "client-123",
          scopes: [],
          fetchUsername: () => Promise.resolve("sam"),
        },
      }),
    );
    db.insert("oauth_states", {
      state: "state-abc",
      account_id: accountId,
      provider: "trakt",
      code_verifier: "verifier-xyz",
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({ access_token: "access-1", expires_in: 7200 }),
        ),
      ),
    );

    const res = await app.request(
      "/oauth/trakt/callback?code=code-1&state=state-abc",
    );

    expect(res.status).toBe(302);
    // The new user's first read is a Baseline, not a list of new titles.
    await vi.waitFor(() => {
      expect(syncRows()).toMatchObject([
        { source_ref: "me/history", connection_user: "sam" },
      ]);
    });
    expect(detectionRows()).toMatchObject([
      { imdb_id: "tt0000002", detected_at: null },
    ]);
    expect(await newTitles()).toEqual([]);
  });
});
