import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import app from "../index.js";
import { saveConnection } from "../services/connections";
import { disconnectProvider } from "../services/lists";
import {
  completeOAuthBody,
  LIST_IDS,
  movie,
  seedConnection,
  seedList,
  seedOAuthState,
} from "./helpers/account.fixture.js";
import { http, HttpResponse } from "msw";
import { useBackgroundTasks } from "./helpers/background.test-utils.js";
import { db } from "./helpers/mock-supabase.js";
import { useMswServer } from "./helpers/msw.test-utils.js";
import {
  accountId,
  detectionRows,
  imdb,
  newTitles,
  newTitlesHandlers,
  resetNewTitlesTest,
  restoreNewTitlesTest,
  seedHistory,
  seedNewTitlesAccount,
  setAccountId,
  sourceList,
  summary,
  syncRows,
  trakt,
} from "./helpers/new-titles.js";
import { accountIdBody, readJson } from "./helpers/json.js";

const server = useMswServer();
const background = useBackgroundTasks();

beforeEach(() => {
  resetNewTitlesTest();
  server.use(...newTitlesHandlers());
});
afterEach(() => {
  restoreNewTitlesTest();
});

describe("settings", () => {
  beforeEach(() => {
    imdb.fail("ChartTitles");
  });

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

  it("turns it on for a new Account", async () => {
    const res = await app.request("/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lists: [LIST], newTitles: { enabled: true } }),
    });
    setAccountId((await readJson(res, accountIdBody)).accountId);

    expect((await summary()).enabled).toBe(true);
  });
});

describe("Connection cleanup", () => {
  it("keeps only the current Connection user's history and public Source lists", async () => {
    seedNewTitlesAccount();
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
    expect(await counts()).toEqual([2, 1]);

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
    sourceList("trakt", [movie("tt0000002")], "me/history");
    trakt.paths.set("/users/settings", {
      status: 200,
      body: { user: { username: "sam" } },
    });
    server.use(
      http.post("https://auth.trakt.tv/oauth/token", () =>
        HttpResponse.json({ access_token: "access-1", expires_in: 7200 }),
      ),
    );
    seedOAuthState(accountId);

    const res = await app.request(
      "/connections/trakt/complete",
      completeOAuthBody(),
    );

    expect(res.status).toBe(200);
    await background.settle();
    expect(syncRows()).toMatchObject([
      { source_ref: "me/history", connection_user: "sam" },
    ]);
    expect(detectionRows()).toMatchObject([
      { imdb_id: "tt0000002", detected_at: null },
    ]);
    expect(await newTitles()).toEqual([]);
  });
});
