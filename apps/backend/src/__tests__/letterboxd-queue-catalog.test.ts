import type {
  StremioMeta,
  AccountSyncSnapshot,
} from "@stremlist/shared/stremio.types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/supabase", () => import("./helpers/mock-supabase.js"));
vi.mock("../services/list-cache", () => import("./helpers/mock-list-cache.js"));
vi.mock("../lib/resend", () => import("../__tests__/helpers/mock-resend"));
vi.mock("../providers/registry", () => import("./helpers/mock-registry.js"));

import app from "../index.js";
import { LetterboxdBusyError } from "../providers/letterboxd-gate";
import {
  currentReadPriority,
  currentReadQueue,
} from "../providers/read-priority";
import type { SourceSnapshot } from "../providers/types";
import { getListCatalog } from "../services/lists";
import { movie, seedAccount, seedList } from "./helpers/fixtures.js";
import { cache } from "./helpers/mock-list-cache.js";
import {
  fakeAdapter,
  resetProviders,
  useFakeProvider,
} from "./helpers/mock-registry.js";
import { db, resetRpc } from "./helpers/mock-supabase.js";

const LIST_ID = "6bde5e3d-617f-4912-950a-2f9acf815b7e";
const REF = "users/alice/watchlist";
const FRESHNESS_MS = 6 * 60 * 60_000;

let accountId = "";

function entry(id: string) {
  return { imdbId: id, meta: movie(id) };
}

function snapshot(ids: string[], more: Partial<SourceSnapshot> = {}) {
  return { entries: ids.map(entry), complete: true, ...more };
}

/** A Letterboxd Provider that reads through `fetchSource`. */
function letterboxd(fetchSource: () => Promise<SourceSnapshot>) {
  const read = vi.fn(fetchSource);
  useFakeProvider(
    fakeAdapter("letterboxd", {
      freshnessMs: FRESHNESS_MS,
      queuedReads: true,
      fetchSource: read,
    }),
  );
  return read;
}

async function catalog(suffix = ".json") {
  const res = await app.request(
    `/${accountId}/catalog/movie/wl-${LIST_ID}-movie${suffix}`,
  );
  return { res, body: (await res.json()) as { metas: StremioMeta[] } };
}

const ids = (body: { metas: StremioMeta[] }) =>
  body.metas.map((meta) => meta.id);

beforeEach(() => {
  db.reset();
  resetRpc();
  cache.reset();
  resetProviders();
  vi.restoreAllMocks();
  accountId = seedAccount().id;
  seedList(accountId, { id: LIST_ID, provider: "letterboxd", source_ref: REF });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a Stremio request for a busy Letterboxd", () => {
  it("shows the on-its-way card instead of a 500, and goes on in the background with the same place in the queue", async () => {
    const tickets: (string | null)[] = [];
    const read = letterboxd(() => {
      tickets.push(currentReadQueue().ticket);
      return read.mock.calls.length === 1
        ? Promise.reject(new LetterboxdBusyError(60_000, { ticket: "t-1" }))
        : Promise.resolve(snapshot(["tt0000001"]));
    });

    const { res, body } = await catalog();

    expect(res.status).toBe(200);
    expect(body.metas).toEqual([
      expect.objectContaining({
        id: "stremlist:queued:letterboxd",
        name: "Your Letterboxd list is on its way",
        description:
          "Letterboxd is busy right now. Stremlist is reading your list and it will show here in a few minutes.",
      }),
    ]);
    // The read goes on in the background and keeps its ticket.
    await vi.waitFor(() => {
      expect(cache.get(LIST_ID)).not.toBeNull();
    });
    expect(tickets).toEqual([null, "t-1"]);
    // A waiting read is not a failed refresh.
    expect(
      db
        .getTable("list_sync_status")
        .filter((row) => row.failure_reason !== null),
    ).toEqual([]);
    expect(ids((await catalog()).body)).toEqual(["tt0000001"]);
  });

  it("shows no card in a search", async () => {
    letterboxd(() => Promise.reject(new LetterboxdBusyError(60_000)));
    const { res, body } = await catalog("/search=alien.json");
    expect(res.status).toBe(200);
    expect(body.metas).toEqual([]);
  });

  it("waits at most 10 s, then shows the card while the read goes on", async () => {
    vi.useFakeTimers();
    let finish: (value: SourceSnapshot) => void = () => undefined;
    letterboxd(
      () =>
        new Promise<SourceSnapshot>((resolve) => {
          finish = resolve;
        }),
    );

    const pending = catalog();
    await vi.advanceTimersByTimeAsync(9_900);
    let answered = false;
    void pending.then(() => (answered = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    const { body } = await pending;
    expect(ids(body)).toEqual(["stremlist:queued:letterboxd"]);

    finish(snapshot(["tt0000002"]));
    await vi.waitFor(() => {
      expect(cache.get(LIST_ID)).not.toBeNull();
    });
  });

  it("serves the pages read so far, comes back soon and completes them in the background", async () => {
    const read = letterboxd(() => Promise.reject(new Error("No more reads")));
    // Hold the background read until the first answer is checked.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    read.mockImplementationOnce(() =>
      Promise.resolve(
        snapshot(["tt0000001"], { complete: false, interrupted: true }),
      ),
    );
    read.mockImplementationOnce(async () => {
      await held;
      return snapshot(["tt0000001", "tt0000002"]);
    });

    const { body } = await catalog();

    expect(ids(body)).toEqual(["tt0000001"]);
    // Back-dated: stale again in about 2 minutes.
    const cached = cache.get(LIST_ID);
    expect(cached).not.toBeNull();
    const age = Date.now() - (cached?.cachedAt.getTime() ?? 0);
    expect(age).toBeGreaterThan(FRESHNESS_MS - 2 * 60_000 - 1_000);
    expect(age).toBeLessThan(FRESHNESS_MS);

    release();
    await vi.waitFor(() => {
      expect(cache.get(LIST_ID)?.data.metas).toHaveLength(2);
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("serves a stale Catalog at once and reads in the background", async () => {
    cache.seed(
      LIST_ID,
      [movie("tt0000009")],
      new Date(Date.now() - FRESHNESS_MS - 60_000),
      { provider: "letterboxd", sourceRef: REF },
    );
    const priorities: string[] = [];
    let finish: (value: SourceSnapshot) => void = () => undefined;
    letterboxd(() => {
      priorities.push(currentReadPriority());
      return new Promise<SourceSnapshot>((resolve) => {
        finish = resolve;
      });
    });

    const { res, body } = await catalog();

    expect(res.status).toBe(200);
    expect(ids(body)).toEqual(["tt0000009"]);
    await vi.waitFor(() => {
      expect(priorities).toEqual(["background"]);
    });
    finish(snapshot(["tt0000010"]));
    await vi.waitFor(() => {
      expect(cache.get(LIST_ID)?.data.metas.map((meta) => meta.id)).toEqual([
        "tt0000010",
      ]);
    });
  });
});

describe("a save that waits for a busy Letterboxd", () => {
  it("shows the estimate on the configure page while the read waits", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    letterboxd(async () => {
      currentReadQueue().onQueued?.(90_000);
      await held;
      return snapshot(["tt0000001"]);
    });
    const prewarm = getListCatalog(
      { id: LIST_ID, provider: "letterboxd", sourceRef: REF },
      {
        accountId,
        sort: { by: "added_at", order: "asc" },
        rpdbApiKey: null,
        allowConnection: true,
        policy: "prewarm",
      },
    );

    const status = async () =>
      (
        (await (
          await app.request(`/${accountId}/sync-status`)
        ).json()) as AccountSyncSnapshot
      ).readQueue ?? {};
    await vi.waitFor(async () => {
      expect(Object.keys(await status())).toEqual([LIST_ID]);
    });
    const queued = (await status())[LIST_ID];
    expect(queued.provider).toBe("letterboxd");
    const readyAt = Date.parse(queued.readyAt);
    expect(readyAt - Date.now()).toBeGreaterThan(80_000);
    expect(readyAt - Date.now()).toBeLessThanOrEqual(90_000);

    release();
    await prewarm;
    expect(await status()).toEqual({});
  });
});
