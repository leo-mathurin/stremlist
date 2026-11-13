import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import app from "../index.js";
import { SourceUnavailableError } from "../providers/types";
import {
  completeOAuthBody,
  movie,
  seedAccount,
  seedConnection,
  seedLegacyAccount,
  seedList,
  seedOAuthState,
} from "./helpers/fixtures.js";
import {
  fakeAdapter,
  resetProviders,
  useFakeProvider,
} from "./helpers/mock-registry.js";
import { db, resetRpc } from "./helpers/mock-supabase.js";
import { readJson, syncSnapshotBody } from "./helpers/json.js";
import { z } from "zod";

vi.mock("../lib/supabase", async () => {
  return await import("./helpers/mock-supabase.js");
});
vi.mock("../services/list-cache", async () => {
  return await import("./helpers/mock-list-cache.js");
});
vi.mock("../providers/registry", async () => {
  return await import("./helpers/mock-registry.js");
});
vi.mock("../lib/resend", () => import("../__tests__/helpers/mock-resend"));

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
  resetProviders();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
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
    useFakeProvider(
      fakeAdapter("trakt", {
        fetchSource: (ref) =>
          ref.endsWith("deleted")
            ? Promise.reject(new SourceUnavailableError("not_found", "gone"))
            : Promise.resolve({
                entries: [{ imdbId: "tt0000001", meta: movie("tt0000001") }],
                complete: true,
              }),
      }),
    );

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
    const fetchSource = vi.fn(() =>
      Promise.resolve({
        entries: [{ imdbId: "tt0000001", meta: movie("tt0000001") }],
        complete: true,
      }),
    );
    useFakeProvider(
      fakeAdapter("trakt", {
        fetchSource,
        oauth: {
          authorizeUrl: "https://trakt.example/oauth/authorize",
          tokenUrl: "https://api.trakt.example/oauth/token",
          clientId: () => "client-123",
          scopes: [],
        },
      }),
    );
    const imdbRead = vi.fn();
    useFakeProvider(fakeAdapter("imdb", { fetchSource: imdbRead }));
    seedOAuthState(account.id);
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({ access_token: "access-1", expires_in: 7200 }),
        ),
      ),
    );

    const res = await app.request(
      "/connections/trakt/complete",
      completeOAuthBody(),
    );

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(
        db.getTable("list_sync_status").find((row) => row.list_id === list.id),
      ).toMatchObject({ failure_reason: null, title_count: 1 });
    });
    expect(fetchSource).toHaveBeenCalledWith("me/watchlist", {
      connection: expect.objectContaining({ provider: "trakt" }) as unknown,
    });
    // Lists on other Providers are not read again.
    expect(imdbRead).not.toHaveBeenCalled();
    expect(
      db.getTable("list_sync_status").some((row) => row.list_id === other.id),
    ).toBe(false);
  });
});
