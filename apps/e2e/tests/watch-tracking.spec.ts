import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import type { WatchTrackingStatus } from "@stremlist/shared/watch-tracking";
import {
  getWatchRows,
  makeSweepDue,
  resetDb,
  seedAccount,
  seedConnection,
  seedStremioLink,
} from "../helpers/db.js";
import type { FixtureBackend } from "../helpers/fixture-backend.js";
import { startFixtureBackend } from "../helpers/fixture-backend.js";
import { configureUrl } from "../helpers/configure.js";
import { routePageTo } from "../helpers/page-backend.js";
import type { FakeStremio } from "../helpers/watch-fixtures.js";

// Watch tracking (ADR 0003) from the request that Stremio sends before a play
// to the write on Trakt and Simkl. The real backend, database and R2 store
// run; Stremio's API answers from a file this test rewrites
// (helpers/watch-fixtures.ts), and the test calls the cron route itself, as
// Vercel Cron does every minute.

const CRON_SECRET = "e2e-cron-secret";
const AUTH_KEY = "fixture-stremio-session";
const MOVIE = "tt0111161";
const SEEN_BEFORE = "tt0068646";
const SHOW = "tt0903747";
const LAST_WATCHED = "2026-11-12T20:40:00.000Z";

let backend: FixtureBackend;
let dir: string;
let stremioFile: string;

function writeStremio(state: FakeStremio): void {
  writeFileSync(stremioFile, JSON.stringify(state));
}

function readStremio(): FakeStremio {
  return JSON.parse(readFileSync(stremioFile, "utf8")) as FakeStremio;
}

/** Stremio's `watched` field with these episodes of season 1 watched. */
function watchedField(episodes: number[]): string {
  const bits = episodes.reduce((sum, episode) => sum | (1 << (episode - 1)), 0);
  const last = Math.max(...episodes);
  const encoded = deflateSync(Buffer.from([bits])).toString("base64");
  return `${SHOW}:1:${last}:${last}:${encoded}`;
}

function movie(id: string, timesWatched: number, mtime: string) {
  return {
    _id: id,
    type: "movie",
    _mtime: mtime,
    state: {
      timesWatched,
      timeWatched: 0,
      duration: 0,
      video_id: id,
      ...(timesWatched > 0 && { lastWatched: LAST_WATCHED }),
    },
  };
}

function series(episodes: number[], mtime: string) {
  return {
    _id: SHOW,
    type: "series",
    _mtime: mtime,
    state: {
      watched: watchedField(episodes),
      lastWatched: LAST_WATCHED,
      timesWatched: 1,
    },
  };
}

async function call(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${backend.url}${path}`, {
    ...init,
    headers: {
      ...(init.json !== undefined && { "content-type": "application/json" }),
      ...init.headers,
    },
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function runCron() {
  const run = await call("/watch/cron", {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  expect(run.status).toBe(200);
  return run.body as {
    reads?: { detected: number };
    sweep?: { accounts: number; detected: number };
    writes?: { sent: number };
    simkl?: { sent: number };
  };
}

/** The watched writes the backend sent to a Provider host. */
function watchedWrites(host: string) {
  return backend
    .requests((url) => url.host === host && url.pathname === "/sync/history")
    .filter((request) => request.method === "POST")
    .map((request) => request.body);
}

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "stremlist-watch-"));
  stremioFile = join(dir, "stremio.json");
  writeStremio({ authKey: AUTH_KEY, trakt: false, library: [], addons: [] });
  backend = await startFixtureBackend("./watch-fixtures.ts", {
    CRON_SECRET,
    E2E_WATCH_STREMIO: stremioFile,
  });
});
test.afterAll(async () => {
  await backend?.stop();
  rmSync(dir, { recursive: true, force: true });
});
test.beforeEach(async () => {
  await resetDb();
  backend.clearRequests();
});

test(
  "a title that turns watched in Stremio is marked on Trakt and Simkl",
  { tag: "@local" },
  async () => {
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt");
    await seedConnection(accountId, "simkl");
    await seedStremioLink(accountId, AUTH_KEY);
    const addonUrl = `${backend.url}/${accountId}/manifest.json`;
    writeStremio({
      authKey: AUTH_KEY,
      trakt: false,
      // Watched before Watch tracking: the Watched baseline, never sent.
      library: [movie(SEEN_BEFORE, 1, "2026-11-01T00:00:00.000Z")],
      addons: [
        {
          transportUrl: addonUrl,
          manifest: { id: "com.stremlist.test", resources: [] },
        },
      ],
    });

    // Turning it on reads the baseline and updates the installed Stremlist.
    const on = await call(`/${accountId}/watch-tracking`, {
      method: "PUT",
      json: { destinations: ["trakt", "simkl"] },
    });
    expect(on.status).toBe(200);
    const { status, stremio } = on.body as {
      status: WatchTrackingStatus;
      stremio: string;
    };
    expect(stremio).toBe("updated");
    expect(status.destinations.map((d) => [d.provider, d.enabled])).toEqual([
      ["trakt", true],
      ["simkl", true],
    ]);
    const installed = readStremio().addons[0].manifest as {
      resources: { name: string }[];
    };
    expect(installed.resources.map((r) => r.name)).toEqual(
      expect.arrayContaining(["stream", "player", "library"]),
    );
    expect((await getWatchRows(accountId)).tracking?.baseline_at).toBeTruthy();

    // Stremio asks for streams before the play: the cycle starts.
    const streams = await call(`/${accountId}/stream/movie/${MOVIE}.json`);
    expect(streams.body).toEqual({ streams: [], cacheMaxAge: 0 });
    await expect
      .poll(async () => (await getWatchRows(accountId)).reads.length)
      .toBe(1);

    // The play reaches Stremio's threshold, and Stremio Web sends `stop`.
    writeStremio({
      ...readStremio(),
      library: [
        movie(SEEN_BEFORE, 1, "2026-11-01T00:00:00.000Z"),
        movie(MOVIE, 1, LAST_WATCHED),
      ],
    });
    const stop = await call(
      `/${accountId}/player/movie/${MOVIE}/action=stop&currentTime=6000000&duration=8520000.json`,
    );
    expect(stop.status).toBe(200);
    await expect
      .poll(async () => {
        const [read] = (await getWatchRows(accountId)).reads;
        return Date.parse(read.due_at) <= Date.now();
      })
      .toBe(true);

    const run = await runCron();
    expect(run.reads?.detected).toBe(1);
    expect(watchedWrites("api.trakt.tv")).toEqual([
      { movies: [{ ids: { imdb: MOVIE }, watched_at: LAST_WATCHED }] },
    ]);
    // Simkl's lane runs beside the reads, through its limiter: the write
    // found by this run goes at the next one.
    expect(watchedWrites("api.simkl.com")).toEqual([]);
    expect((await runCron()).simkl?.sent).toBe(1);
    expect(watchedWrites("api.simkl.com")).toEqual([
      { movies: [{ ids: { imdb: MOVIE }, watched_at: LAST_WATCHED }] },
    ]);
    expect((await getWatchRows(accountId)).writes).toEqual([]);

    // Nothing is sent twice, and the baseline title never.
    await runCron();
    expect(watchedWrites("api.trakt.tv")).toHaveLength(1);

    const after = await call(`/${accountId}/watch-tracking`);
    const trakt = (after.body as WatchTrackingStatus).destinations[0];
    expect(trakt).toMatchObject({
      provider: "trakt",
      lastTitle: { imdbId: MOVIE, type: "movie" },
      lastError: null,
      pending: 0,
    });
  },
);

test(
  "the sweep sends episodes that the trigger missed, and stops when turned off",
  { tag: "@local" },
  async () => {
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt");
    await seedStremioLink(accountId, AUTH_KEY);
    writeStremio({
      authKey: AUTH_KEY,
      trakt: false,
      library: [series([1], "2026-11-01T00:00:00.000Z")],
      addons: [],
    });
    const on = await call(`/${accountId}/watch-tracking`, {
      method: "PUT",
      json: { destinations: ["trakt"] },
    });
    expect(on.status).toBe(200);

    // Episodes 2 and 3 marked on Android TV: no event, the sweep finds them.
    writeStremio({
      ...readStremio(),
      library: [series([1, 2, 3], "2026-11-12T20:41:00.000Z")],
    });
    await makeSweepDue(accountId);
    const run = await runCron();
    expect(run.sweep).toMatchObject({ accounts: 1, detected: 2 });
    // The sweep runs after the writes: what it finds goes at the next run.
    await runCron();
    // The episodes of one series, marked together, go in one request.
    const [sent, ...more] = watchedWrites("api.trakt.tv") as {
      shows: { seasons: { episodes: { number: number }[] }[] }[];
    }[];
    expect(more).toEqual([]);
    expect(sent.shows).toHaveLength(1);
    expect(sent.shows[0]).toMatchObject({ ids: { imdb: SHOW } });
    expect(
      sent.shows[0].seasons[0].episodes
        .map((e) => e)
        .sort((a, b) => a.number - b.number),
    ).toEqual([
      { number: 2, watched_at: LAST_WATCHED },
      { number: 3, watched_at: LAST_WATCHED },
    ]);

    // Stremio's own Trakt connected: Trakt is paused, nothing more is sent.
    writeStremio({ ...readStremio(), trakt: true });
    const paused = await call(`/${accountId}/watch-tracking`, {
      method: "PUT",
      json: { destinations: ["trakt"] },
    });
    expect(
      (paused.body as { status: WatchTrackingStatus }).status.destinations[0],
    ).toMatchObject({ enabled: true, paused: true });

    const off = await call(`/${accountId}/watch-tracking`, {
      method: "PUT",
      json: { destinations: [] },
    });
    expect(off.status).toBe(200);
    expect((await getWatchRows(accountId)).tracking).toBeNull();
  },
);

test(
  "a manual mark in Stremio Web is sent a few seconds later",
  { tag: "@local" },
  async () => {
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt");
    await seedStremioLink(accountId, AUTH_KEY);
    writeStremio({
      authKey: AUTH_KEY,
      trakt: false,
      library: [movie(MOVIE, 0, "2026-11-01T00:00:00.000Z")],
      addons: [],
    });
    const on = await call(`/${accountId}/watch-tracking`, {
      method: "PUT",
      json: { destinations: ["trakt"] },
    });
    expect(on.status).toBe(200);

    // The member marks the movie on its page: no /stream, no cycle.
    writeStremio({
      ...readStremio(),
      library: [movie(MOVIE, 1, LAST_WATCHED)],
    });
    const mark = await call(
      `/${accountId}/library/movie/${MOVIE}/action=watched.json`,
    );
    expect(mark.status).toBe(200);
    // Other library actions start nothing.
    await call(`/${accountId}/library/movie/${MOVIE}/action=libraryAdd.json`);
    await expect
      .poll(async () => (await getWatchRows(accountId)).writes.length, {
        timeout: 10_000,
      })
      .toBe(1);
    expect((await getWatchRows(accountId)).reads).toEqual([]);

    await runCron();
    expect(watchedWrites("api.trakt.tv")).toEqual([
      { movies: [{ ids: { imdb: MOVIE }, watched_at: LAST_WATCHED }] },
    ]);
  },
);

test(
  "Watch tracking needs a Stremio link and a connected Destination",
  { tag: "@local" },
  async () => {
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt");
    const unlinked = await call(`/${accountId}/watch-tracking`, {
      method: "PUT",
      json: { destinations: ["trakt"] },
    });
    expect(unlinked).toEqual({
      status: 409,
      body: { reason: "stremio-not-linked" },
    });
    await seedStremioLink(accountId, AUTH_KEY);
    const missing = await call(`/${accountId}/watch-tracking`, {
      method: "PUT",
      json: { destinations: ["simkl"] },
    });
    expect(missing).toEqual({ status: 400, body: { reason: "not-connected" } });
    const cron = await call("/watch/cron");
    expect(cron.status).toBe(401);
  },
);

test(
  "the configure page turns Watch tracking on and shows the last title",
  { tag: "@local" },
  async ({ page }) => {
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt");
    await seedConnection(accountId, "simkl");
    await seedStremioLink(accountId, AUTH_KEY);
    writeStremio({
      authKey: AUTH_KEY,
      trakt: false,
      library: [movie(MOVIE, 0, "2026-11-01T00:00:00.000Z")],
      addons: [
        {
          transportUrl: `${backend.url}/${accountId}/manifest.json`,
          manifest: { id: "com.stremlist.test", resources: [] },
        },
      ],
    });
    await routePageTo(page, backend.url);
    await page.goto(configureUrl(accountId));

    const section = page.getByRole("region", {
      name: "Mark as watched automatically",
    });
    await expect(section).toBeVisible();
    const trakt = section.getByRole("checkbox", { name: /Trakt/ });
    await expect(trakt).not.toBeChecked();
    await expect(
      section.getByRole("checkbox", { name: /Simkl/ }),
    ).not.toBeChecked();

    await trakt.click();
    await expect(
      section.getByText("On. Titles you finish from now on go here."),
    ).toBeVisible();
    await expect(trakt).toBeChecked();
    expect((await getWatchRows(accountId)).tracking?.baseline_at).toBeTruthy();

    // A title turns watched and is sent: the page shows it after a reload.
    writeStremio({
      ...readStremio(),
      library: [movie(MOVIE, 1, LAST_WATCHED)],
    });
    await call(`/${accountId}/library/movie/${MOVIE}/action=watched.json`);
    await expect
      .poll(async () => (await getWatchRows(accountId)).writes.length, {
        timeout: 10_000,
      })
      .toBe(1);
    await runCron();
    await page.reload();
    await expect(section.getByText(/Last marked/)).toBeVisible();

    await section.getByRole("checkbox", { name: /Trakt/ }).click();
    await expect(section.getByText("Off").first()).toBeVisible();
    await expect
      .poll(async () => (await getWatchRows(accountId)).tracking)
      .toBeNull();
  },
);

test(
  "Watch tracking asks for a Stremio link first",
  { tag: "@local" },
  async ({ page }) => {
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt");
    await routePageTo(page, backend.url);
    await page.goto(configureUrl(accountId));
    const section = page.getByRole("region", {
      name: "Mark as watched automatically",
    });
    await expect(
      section.getByText(/Link your Stremio account first/),
    ).toBeVisible();
    await expect(
      section.getByRole("button", { name: "Link Stremio" }),
    ).toBeVisible();
    await expect(section.getByRole("checkbox")).toHaveCount(0);
  },
);
