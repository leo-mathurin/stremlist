import { http, HttpResponse } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import app from "../../index.js";
import {
  completeOAuthBody,
  movie,
  seedAccount,
  seedConnection,
  seedLegacyAccount,
  seedList,
  seedOAuthState,
} from "../../test/helpers/account.fixture.js";
import { useBackgroundTasks } from "../../test/helpers/background.test-utils.js";
import {
  cinemetaWithoutTitles,
  FakeImdb,
} from "../../test/helpers/imdb.test-utils.js";
import { cache } from "../../test/helpers/list-cache.test-utils.js";
import { db, resetRpc } from "../../test/helpers/mock-supabase.js";
import { useMswServer } from "../../test/helpers/msw.test-utils.js";
import { resetR2 } from "../../test/helpers/r2.test-utils.js";
import {
  FakeTrakt,
  TRAKT_API,
  useTraktApp,
} from "../../test/helpers/trakt.test-utils.js";
import { readJson, syncSnapshotBody } from "../../test/helpers/json.js";
import { z } from "zod";

const TRAKT_AUTH = "https://auth.trakt.tv";
const server = useMswServer();
const background = useBackgroundTasks();
const trakt = new FakeTrakt();
const imdb = new FakeImdb();

const TEN_MINUTES_AGO = new Date(Date.now() - 10 * 60_000).toISOString();

function seedStatus(
  listId: string,
  provider: string,
  sourceRef: string,
  overrides: Record<string, unknown> = {},
) {
  db.insert("list_sync_status", {
    list_id: listId,
    provider,
    source_ref: sourceRef,
    last_attempt_at: "2026-10-06T12:00:00.000Z",
    last_success_at: "2026-10-06T12:00:00.000Z",
    title_count: 3,
    ...overrides,
  });
}

beforeEach(() => {
  db.reset();
  resetRpc();
  resetR2();
  cache.reset();
  trakt.reset();
  imdb.reset();
  useTraktApp();
  server.use(trakt.handler, imdb.handler, cinemetaWithoutTitles);
  vi.spyOn(console, "log");
  vi.spyOn(console, "error");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sync status on the configure page", () => {
  it("returns each List's status and the Connections to renew with the config", async () => {
    const account = seedAccount();
    const imdb = seedList(account.id, { source_ref: "imdb:top-rated-movies" });
    const trakt = seedList(account.id, {
      provider: "trakt",
      source_ref: "me/watchlist",
      position: 1,
    });
    seedStatus(imdb.id, "imdb", "imdb:top-rated-movies");
    seedStatus(trakt.id, "trakt", "me/watchlist", {
      failure_reason: "needs_connection",
      failing_since: "2026-10-06T12:00:00.000Z",
    });
    seedConnection(account.id, "trakt");
    db.getTable("connections")[0].needs_renewal_since =
      "2026-10-06T12:00:00.000Z";

    const res = await app.request(`/${account.id}/config`);
    const body = await readJson(res, syncSnapshotBody);

    expect(body.syncStatus).toEqual({
      [imdb.id]: [
        {
          provider: "imdb",
          sourceRef: "imdb:top-rated-movies",
          lastAttemptAt: "2026-10-06T12:00:00.000Z",
          lastSuccessAt: "2026-10-06T12:00:00.000Z",
          titleCount: 3,
          problem: null,
          failingSince: null,
        },
      ],
      [trakt.id]: [
        expect.objectContaining({
          problem: "needs_connection",
        }) as unknown,
      ],
    });
    expect(body.connections).toEqual([
      expect.objectContaining({
        provider: "trakt",
        needsRenewalSince: "2026-10-06T12:00:00.000Z",
      }),
    ]);
  });

  it("answers the sync status alone for polling", async () => {
    const account = seedAccount();
    const list = seedList(account.id, { source_ref: "imdb:top-rated-movies" });
    seedStatus(list.id, "imdb", "imdb:top-rated-movies", {
      failure_reason: "unavailable",
      failing_since: "2026-10-06T12:00:00.000Z",
    });

    const res = await app.request(`/${account.id}/sync-status`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      syncStatus: {
        [list.id]: [
          expect.objectContaining({
            problem: "unavailable",
          }) as unknown,
        ],
      },
      connections: [],
      readQueue: {},
    });
  });

  it("shows a Legacy alias only its public Lists and no Connection", async () => {
    const account = seedLegacyAccount("ur12345678");
    const watchlist = seedList(account.id, { source_ref: "ur12345678" });
    const trakt = seedList(account.id, {
      provider: "trakt",
      source_ref: "me/history",
      position: 1,
    });
    seedStatus(watchlist.id, "imdb", "ur12345678");
    seedStatus(trakt.id, "trakt", "me/history");
    seedConnection(account.id, "trakt");

    const body = await readJson(
      await app.request("/ur12345678/sync-status"),
      syncSnapshotBody,
    );

    expect(Object.keys(body.syncStatus)).toEqual([watchlist.id]);
    expect(body.connections).toEqual([]);
  });

  it("answers 404 for an unknown Account", async () => {
    const res = await app.request("/sl_0000000000000000000000/sync-status");
    expect(res.status).toBe(404);
  });

  it("returns the new statuses after a manual refresh", async () => {
    const account = seedAccount({ last_fetched_at: TEN_MINUTES_AGO });
    const good = seedList(account.id, {
      provider: "trakt",
      source_ref: "users/leo/lists/horror",
    });
    const gone = seedList(account.id, {
      provider: "trakt",
      source_ref: "users/leo/lists/deleted",
      position: 1,
    });
    trakt.serve("/users/leo/lists/horror/items", [movie("tt0000001")]);
    trakt.fail("/users/leo/lists/deleted/items", 404);
    imdb.titles.set("tt0000001", movie("tt0000001"));

    const res = await app.request(`/${account.id}/refresh`, {
      method: "POST",
    });
    const body = await readJson(
      res,
      syncSnapshotBody.extend({ failed: z.number() }),
    );

    expect(body.failed).toBe(1);
    expect(body.syncStatus[good.id]).toEqual([
      expect.objectContaining({ problem: null, titleCount: 1 }),
    ]);
    expect(body.syncStatus[gone.id]).toEqual([
      expect.objectContaining({ problem: "not_found", lastSuccessAt: null }),
    ]);
  });
});

describe("after a new Connection", () => {
  it("reads the Provider's Lists again through it", async () => {
    const account = seedAccount();
    const list = seedList(account.id, {
      provider: "trakt",
      source_ref: "me/watchlist",
    });
    const other = seedList(account.id, {
      source_ref: "imdb:top-rated-movies",
      position: 1,
    });
    seedStatus(list.id, "trakt", "me/watchlist", {
      failure_reason: "needs_connection",
      failing_since: "2026-10-06T12:00:00.000Z",
    });
    trakt.serve("/users/me/watchlist", [movie("tt0000001")]);
    imdb.titles.set("tt0000001", movie("tt0000001"));
    server.use(
      http.post(`${TRAKT_AUTH}/oauth/token`, () =>
        HttpResponse.json({ access_token: "access-1", expires_in: 7200 }),
      ),
      http.get(`${TRAKT_API}/users/settings`, () =>
        HttpResponse.json({ user: { username: "leo" } }),
      ),
    );
    seedOAuthState(account.id);

    const res = await app.request(
      "/connections/trakt/complete",
      completeOAuthBody(),
    );

    expect(res.status).toBe(200);
    await background.settle();
    expect(
      db.getTable("list_sync_status").find((row) => row.list_id === list.id),
    ).toMatchObject({ failure_reason: null, title_count: 1 });
    expect(
      trakt.requestsOf("/users/me/watchlist").map((request) => request.token),
    ).toEqual(["access-1"]);
    expect(
      imdb.requests.filter((request) => request.operationName !== "TitlesById"),
    ).toEqual([]);
    expect(
      db.getTable("list_sync_status").some((row) => row.list_id === other.id),
    ).toBe(false);
  });
});
