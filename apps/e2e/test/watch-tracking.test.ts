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
  withHeldSimklWrite,
} from "../helpers/db.js";
import type { FixtureBackend } from "../helpers/fixture-backend.js";
import { startFixtureBackend } from "../helpers/fixture-backend.js";
import { configureUrl } from "../helpers/configure.js";
import { routePageTo } from "../helpers/page-backend.js";
import { BACKEND_URL } from "../env.js";
import { type FakeStremio, isFakeStremio } from "../helpers/fake-stremio.js";
import { isRecord, optional, parseJson, parsed } from "../helpers/json.js";

const CRON_SECRET = "e2e-cron-secret";
const AUTH_KEY = "fixture-stremio-session";
const MOVIE = "tt0111161";
const SEEN_BEFORE = "tt0068646";
const SHOW = "tt0903747";
const LAST_WATCHED = "2026-11-12T20:40:00.000Z";

let backend: FixtureBackend;
let dir: string;
let stremioFile: string;

function writeStremio(state: FakeStremio) {
  writeFileSync(stremioFile, JSON.stringify(state));
}

function readStremio() {
  return parseJson(readFileSync(stremioFile, "utf8"), isFakeStremio, "Stremio");
}

function resourceNames(manifest: unknown) {
  if (!isRecord(manifest) || !Array.isArray(manifest.resources)) return [];
  return manifest.resources.map((resource: unknown) =>
    isRecord(resource) ? resource.name : undefined,
  );
}

function isWatchStatus(value: unknown): value is WatchTrackingStatus {
  return (
    isRecord(value) &&
    typeof value.stremioLinked === "boolean" &&
    Array.isArray(value.destinations) &&
    value.destinations.every(isRecord)
  );
}

function isWatchUpdate(
  value: unknown,
): value is { status: WatchTrackingStatus; stremio: unknown } {
  return isRecord(value) && isWatchStatus(value.status) && "stremio" in value;
}

const counts = (keys: string[]) => (value: unknown) =>
  isRecord(value) && keys.every((key) => typeof value[key] === "number");

function isCronReport(value: unknown): value is {
  reads?: { detected: number };
  sweep?: { accounts: number; detected: number };
  writes?: { sent: number };
  simkl?: { sent: number };
} {
  return (
    isRecord(value) &&
    optional(value.reads, counts(["detected"])) &&
    optional(value.sweep, counts(["accounts", "detected"])) &&
    optional(value.writes, counts(["sent"])) &&
    optional(value.simkl, counts(["sent"]))
  );
}

const everyRecord = (
  value: unknown,
  is: (item: Record<string, unknown>) => boolean,
) => Array.isArray(value) && value.every((item) => isRecord(item) && is(item));

function isShowsWrite(value: unknown): value is {
  shows: { seasons: { episodes: { number: number }[] }[] }[];
} {
  return (
    isRecord(value) &&
    everyRecord(value.shows, (show) =>
      everyRecord(show.seasons, (season) =>
        everyRecord(season.episodes, counts(["number"])),
      ),
    )
  );
}

function watchedField(episodes: number[]) {
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

async function call(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.json !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${backend.url}${path}`, {
    ...init,
    headers,
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
  });
  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : null;
  return { status: response.status, body };
}

async function runCron() {
  const run = await call("/watch/cron", {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  expect(run.status).toBe(200);
  return parsed(run.body, isCronReport, "cron report");
}

function watchedWrites(host: string, path = "/sync/history") {
  return backend
    .requests((url) => url.host === host && url.pathname === path)
    .filter((request) => request.method === "POST")
    .map((request) => request.body);
}

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "stremlist-watch-"));
  stremioFile = join(dir, "stremio.json");
  writeStremio({ authKey: AUTH_KEY, trakt: false, library: [], addons: [] });
  backend = await startFixtureBackend("./watch.fixture.ts", {
    CRON_SECRET,
    E2E_WATCH_STREMIO: stremioFile,
    E2E_WATCH_SIMKL_FAILURE: join(dir, "simkl-failure"),
  });
});
test.afterAll(async () => {
  try {
    await backend?.stop();
  } finally {
    try {
      await resetDb();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
test.beforeEach(async () => {
  await resetDb();
  backend.clearRequests();
  writeFileSync(join(dir, "simkl-failure"), "up");
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
      library: [movie(SEEN_BEFORE, 1, "2026-11-01T00:00:00.000Z")],
      addons: [
        {
          transportUrl: addonUrl,
          manifest: { id: "com.stremlist.test", resources: [] },
        },
      ],
    });

    const on = await call(`/${accountId}/watch-tracking`, {
      method: "PUT",
      json: { consent: true, destinations: ["trakt", "simkl"] },
    });
    expect(on.status).toBe(200);
    const { status, stremio } = parsed(
      on.body,
      isWatchUpdate,
      "watch tracking update",
    );
    expect(stremio).toBe("updated");
    expect(status.destinations.map((d) => [d.provider, d.enabled])).toEqual([
      ["trakt", true],
      ["simkl", true],
    ]);
    expect(resourceNames(readStremio().addons[0].manifest)).toEqual(
      expect.arrayContaining(["stream", "player", "library"]),
    );
    expect((await getWatchRows(accountId)).tracking?.baseline_at).toBeTruthy();

    const streams = await call(`/${accountId}/stream/movie/${MOVIE}.json`);
    expect(streams.body).toEqual({ streams: [], cacheMaxAge: 0 });
    await expect
      .poll(async () => (await getWatchRows(accountId)).reads.length)
      .toBe(1);

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
    expect(watchedWrites("api.simkl.com")).toEqual([]);
    expect((await runCron()).simkl?.sent).toBe(1);
    expect(watchedWrites("api.simkl.com")).toEqual([
      { movies: [{ ids: { imdb: MOVIE }, watched_at: LAST_WATCHED }] },
    ]);
    expect((await getWatchRows(accountId)).writes).toEqual([]);

    await runCron();
    expect(watchedWrites("api.trakt.tv")).toHaveLength(1);

    const after = await call(`/${accountId}/watch-tracking`);
    const trakt = parsed(after.body, isWatchStatus, "watch tracking status")
      .destinations[0];
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
      json: { consent: true, destinations: ["trakt"] },
    });
    expect(on.status).toBe(200);

    writeStremio({
      ...readStremio(),
      library: [series([1, 2, 3], "2026-11-12T20:41:00.000Z")],
    });
    await makeSweepDue(accountId);
    const run = await runCron();
    expect(run.sweep).toMatchObject({ accounts: 1, detected: 2 });
    await runCron();
    const [sent, ...more] = watchedWrites("api.trakt.tv").map((write) =>
      parsed(write, isShowsWrite, "Trakt watched write"),
    );
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

    writeStremio({ ...readStremio(), trakt: true });
    const paused = await call(`/${accountId}/watch-tracking`, {
      method: "PUT",
      json: { consent: true, destinations: ["trakt"] },
    });
    expect(
      parsed(paused.body, isWatchUpdate, "watch tracking update").status
        .destinations[0],
    ).toMatchObject({ enabled: true, paused: true });

    const off = await call(`/${accountId}/watch-tracking`, {
      method: "PUT",
      json: { consent: true, destinations: [] },
    });
    expect(off.status).toBe(200);
    expect((await getWatchRows(accountId)).tracking).toBeNull();
  },
);

test(
  "an episode that turns watched as the next one starts is sent to MDBList",
  { tag: "@local" },
  async () => {
    const accountId = await seedAccount();
    await seedConnection(accountId, "mdblist");
    await seedStremioLink(accountId, AUTH_KEY);
    writeStremio({
      authKey: AUTH_KEY,
      trakt: false,
      library: [series([1], "2026-11-01T00:00:00.000Z")],
      addons: [],
    });
    const on = await call(`/${accountId}/watch-tracking`, {
      method: "PUT",
      json: { destinations: ["mdblist"], consent: true },
    });
    expect(on.status).toBe(200);

    await call(`/${accountId}/stream/series/${SHOW}:1:2.json`);
    await expect
      .poll(async () => (await getWatchRows(accountId)).reads.length)
      .toBe(1);
    writeStremio({
      ...readStremio(),
      library: [series([1, 2], "2026-11-12T20:41:00.000Z")],
    });
    await call(`/${accountId}/stream/series/${SHOW}:1:3.json`);
    await expect
      .poll(async () => (await getWatchRows(accountId)).writes.length, {
        timeout: 10_000,
      })
      .toBe(1);

    await runCron();
    expect(watchedWrites("api.mdblist.com", "/sync/watched")).toEqual([
      {
        shows: [
          expect.objectContaining({
            ids: expect.objectContaining({ imdb: SHOW }),
            seasons: [
              {
                number: 1,
                episodes: [{ number: 2, watched_at: LAST_WATCHED }],
              },
            ],
          }),
        ],
      },
    ]);
    expect((await getWatchRows(accountId)).writes).toEqual([]);
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
      json: { consent: true, destinations: ["trakt"] },
    });
    expect(on.status).toBe(200);

    writeStremio({
      ...readStremio(),
      library: [movie(MOVIE, 1, LAST_WATCHED)],
    });
    const mark = await call(
      `/${accountId}/library/movie/${MOVIE}/action=watched.json`,
    );
    expect(mark.status).toBe(200);
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
      json: { consent: true, destinations: ["trakt"] },
    });
    expect(unlinked).toEqual({
      status: 409,
      body: { reason: "stremio-not-linked" },
    });
    await seedStremioLink(accountId, AUTH_KEY);
    const missing = await call(`/${accountId}/watch-tracking`, {
      method: "PUT",
      json: { consent: true, destinations: ["simkl"] },
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
      name: "Update your accounts from Stremio",
    });
    await expect(section).toBeVisible();
    const trakt = section.getByRole("button", {
      name: "Mark as watched on Trakt",
      exact: true,
    });
    await expect(trakt).toHaveAttribute("aria-pressed", "false");
    await expect(
      section.getByRole("button", {
        name: "Mark as watched on Simkl",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "false");

    await trakt.click();
    await page
      .getByRole("button", { name: "Allow and turn on", exact: true })
      .click();
    await expect(
      section.getByText("Sharing on", { exact: true }),
    ).toBeVisible();
    await expect(
      section.getByText("On. Titles you finish from now on are marked."),
    ).not.toBeVisible();
    await expect(trakt).toHaveAttribute("aria-pressed", "true");
    expect((await getWatchRows(accountId)).tracking?.baseline_at).toBeTruthy();

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
    await section.getByRole("button", { name: "Details", exact: true }).click();
    await expect(section.getByText(/Last marked/)).toBeVisible();

    await section
      .getByRole("button", { name: "Mark as watched on Trakt", exact: true })
      .click();
    await expect(
      section.getByText("Only new activity is shared, with your permission."),
    ).toBeVisible();
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
      name: "Update your accounts from Stremio",
    });
    await expect(section.getByText(/Start with Stremio/)).toBeVisible();
    await expect(
      section.getByRole("button", { name: "Link Stremio" }),
    ).toBeVisible();
    await expect(section.getByRole("checkbox")).toHaveCount(0);
  },
);

test(
  "a refused change puts the checkbox back and says why",
  { tag: "@local" },
  async ({ page }) => {
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt");
    await seedStremioLink(accountId, AUTH_KEY);
    await routePageTo(page, backend.url);
    await page.route(`${BACKEND_URL}/*/watch-tracking`, async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      await route.fulfill({ status: 502, json: { reason: "unavailable" } });
    });
    await page.goto(configureUrl(accountId));
    const section = page.getByRole("region", {
      name: "Update your accounts from Stremio",
    });
    const trakt = section.getByRole("button", {
      name: "Mark as watched on Trakt",
      exact: true,
    });
    await trakt.click();
    await page
      .getByRole("button", { name: "Allow and turn on", exact: true })
      .click();
    await expect(
      page.getByText("Stremlist could not read your Stremio library."),
    ).toBeVisible();
    await expect(trakt).toHaveAttribute("aria-pressed", "false");

    await expect(
      section.getByText("Only new activity is shared, with your permission."),
    ).toBeVisible();
    expect((await getWatchRows(accountId)).tracking).toBeNull();
  },
);

test(
  "player events recover a missing cycle once and still wait for native watched status",
  { tag: "@local" },
  async () => {
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt");
    await seedStremioLink(accountId, AUTH_KEY);
    writeStremio({
      authKey: AUTH_KEY,
      trakt: false,
      library: [movie(SEEN_BEFORE, 1, LAST_WATCHED)],
      addons: [],
    });
    expect(
      (
        await call(`/${accountId}/watch-tracking`, {
          method: "PUT",
          json: { destinations: ["trakt"], consent: true },
        })
      ).status,
    ).toBe(200);
    const path = `/${accountId}/player/movie/${MOVIE}`;
    const start = await call(
      `${path}/action=start&currentTime=0&duration=0.json`,
    );
    expect(start).toEqual({ status: 200, body: { success: true } });
    await Promise.all(
      Array.from({ length: 12 }, () =>
        call(`${path}/action=stop&currentTime=95&duration=100.json`),
      ),
    );
    const rows = await getWatchRows(accountId);
    expect(rows.reads).toHaveLength(1);
    expect(rows.reads[0].generation).toBe(1);
    await runCron();
    expect(watchedWrites("api.trakt.tv")).toEqual([]);
    writeStremio({
      ...readStremio(),
      library: [
        movie(SEEN_BEFORE, 1, LAST_WATCHED),
        movie(MOVIE, 1, LAST_WATCHED),
      ],
    });
    await call(`${path}/action=stop.json`);
    await runCron();
    expect(watchedWrites("api.trakt.tv")).toHaveLength(1);
    await call(`/${accountId}/player/movie/${SEEN_BEFORE}/action=stop.json`);
    await runCron();
    expect(watchedWrites("api.trakt.tv")).toHaveLength(1);
    expect(
      (await call(`${path}/action=start&currentTime=broken.json`)).status,
    ).toBe(400);
    expect(
      (await call(`/${accountId}/player/other/${MOVIE}/action=start.json`))
        .status,
    ).toBe(400);
  },
);

test(
  "consented library additions use independent durable destinations, retry and keep history",
  { tag: "@local" },
  async ({ page }) => {
    const accountId = await seedAccount();
    for (const provider of ["trakt", "simkl", "mdblist"] as const)
      await seedConnection(accountId, provider);
    await seedStremioLink(accountId, AUTH_KEY);
    writeStremio({ authKey: AUTH_KEY, trakt: true, library: [], addons: [] });
    const event = `/${accountId}/library/movie/${MOVIE}`;
    await call(`${event}/action=libraryAdd.json`);
    expect((await getWatchRows(accountId)).writes).toEqual([]);
    const choices = {
      destinations: [],
      watchlistDestinations: ["trakt", "simkl", "mdblist"],
    };
    expect(
      await call(`/${accountId}/watch-tracking`, {
        method: "PUT",
        json: choices,
      }),
    ).toEqual({ status: 409, body: { reason: "consent-required" } });
    expect(
      (
        await call(`/${accountId}/watch-tracking`, {
          method: "PUT",
          json: { ...choices, consent: true },
        })
      ).status,
    ).toBe(200);
    await Promise.all(
      Array.from({ length: 10 }, () => call(`${event}/action=libraryAdd.json`)),
    );
    expect((await getWatchRows(accountId)).writes).toHaveLength(3);
    writeFileSync(join(dir, "simkl-failure"), "down");
    await runCron();
    const waiting = (await getWatchRows(accountId)).writes;
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      provider: "simkl",
      kind: "watchlist",
      attempts: 1,
    });
    expect(
      backend
        .requests(
          (url) =>
            url.host === "api.trakt.tv" && url.pathname === "/sync/watchlist",
        )
        .filter((r) => r.method === "POST"),
    ).toHaveLength(1);
    expect(
      backend
        .requests(
          (url) =>
            url.host === "api.mdblist.com" &&
            url.pathname === "/watchlist/items/add",
        )
        .filter((r) => r.method === "POST"),
    ).toHaveLength(1);
    expect(watchedWrites("api.trakt.tv")).toEqual([]);
    await routePageTo(page, backend.url);
    await page.goto(configureUrl(accountId));
    const activity = page.getByRole("region", {
      name: "Update your accounts from Stremio",
    });
    await expect(
      activity.getByRole("button", { name: "Details", exact: true }),
    ).toHaveAttribute("aria-expanded", "false");
    await expect(activity.getByText("1 update waiting.")).toBeVisible();
    writeFileSync(join(dir, "simkl-failure"), "up");
    const retried = page.waitForResponse(
      (response) =>
        response.url().endsWith("/watch-tracking/retry") &&
        response.request().method() === "POST",
    );
    await activity
      .getByRole("button", { name: "Retry now", exact: true })
      .click();
    expect((await retried).status()).toBe(200);
    await runCron();
    expect((await getWatchRows(accountId)).writes).toEqual([]);
    const sent = backend
      .requests((url) => url.pathname === "/sync/add-to-list")
      .filter((r) => r.method === "POST");
    expect(sent.at(-1)?.body).toEqual({
      movies: [{ ids: { imdb: MOVIE }, to: "plantowatch" }],
    });
    const count = backend.requests().length;
    await call(`${event}/action=libraryAdd.json`);
    await call(`${event}/action=libraryRemove.json`);
    await call(`${event}/action=unwatched.json`);
    expect((await getWatchRows(accountId)).writes).toEqual([]);
    expect(backend.requests().length).toBe(count);
    expect(
      (
        await call(`/${accountId}/watch-tracking`, {
          method: "PUT",
          json: { destinations: [], watchlistDestinations: [] },
        })
      ).status,
    ).toBe(200);
    expect((await getWatchRows(accountId)).tracking).toBeNull();
    await call(`${event}/action=libraryAdd.json`);
    expect((await getWatchRows(accountId)).writes).toEqual([]);
  },
);

test(
  "card A saves independent choices after explicit consent and confirms stop sharing",
  { tag: "@local" },
  async ({ page }, testInfo) => {
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt");
    await seedConnection(accountId, "simkl");
    await seedStremioLink(accountId, AUTH_KEY);
    writeStremio({ authKey: AUTH_KEY, trakt: false, library: [], addons: [] });
    await routePageTo(page, backend.url);
    await page.goto(configureUrl(accountId));
    const section = page.getByRole("region", {
      name: "Update your accounts from Stremio",
    });
    const watched = section.getByRole("button", {
      name: "Mark as watched on Trakt",
      exact: true,
    });
    const watchlist = section.getByRole("button", {
      name: "Add to watchlist on Simkl",
      exact: true,
    });
    await watched.click();
    await page.getByRole("button", { name: "Not now", exact: true }).click();
    await expect(watched).toHaveAttribute("aria-pressed", "false");
    expect((await getWatchRows(accountId)).tracking).toBeNull();
    await watched.click();
    await page
      .getByRole("button", { name: "Allow and turn on", exact: true })
      .click();
    await expect(watched).toHaveAttribute("aria-pressed", "true");
    await expect(watchlist).toBeEnabled();
    await watchlist.click();
    await expect(watchlist).toHaveAttribute("aria-pressed", "true");
    await expect(watchlist).toBeEnabled();
    await page.reload();
    await expect(watched).toHaveAttribute("aria-pressed", "true");
    await expect(watchlist).toHaveAttribute("aria-pressed", "true");
    await expect(
      section.getByRole("button", {
        name: "Mark as watched on Simkl",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "false");
    const saved = parsed(
      (await call(`/${accountId}/watch-tracking`)).body,
      isWatchStatus,
      "saved activity",
    );
    expect(saved.consented).toBe(true);
    expect(
      saved.destinations.map((d) => [
        d.provider,
        d.enabled,
        d.watchlistEnabled,
      ]),
    ).toEqual([
      ["trakt", true, false],
      ["simkl", false, true],
    ]);
    await page.setViewportSize({ width: 390, height: 844 });
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("a-phone.png") });
    await section
      .getByRole("button", { name: "Stop sharing", exact: true })
      .click();
    await expect(
      section.getByRole("button", { name: "Keep sharing", exact: true }),
    ).toBeVisible();
    expect((await getWatchRows(accountId)).tracking).not.toBeNull();
    await section
      .getByRole("button", { name: "Stop sharing", exact: true })
      .click();
    await expect(watchlist).toHaveAttribute("aria-pressed", "false");
    await expect(watched).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(async () => (await getWatchRows(accountId)).tracking)
      .toBeNull();
  },
);

test(
  "sharing can be stopped after the Stremio link is removed",
  { tag: "@local" },
  async ({ page }) => {
    const accountId = await seedAccount();
    await seedConnection(accountId, "trakt");
    await seedStremioLink(accountId, AUTH_KEY);
    writeStremio({ authKey: AUTH_KEY, trakt: false, library: [], addons: [] });
    expect(
      (
        await call(`/${accountId}/watch-tracking`, {
          method: "PUT",
          json: {
            destinations: [],
            watchlistDestinations: ["trakt"],
            consent: true,
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(`/${accountId}/stremio`, { method: "DELETE" })).status,
    ).toBe(200);
    await routePageTo(page, backend.url);
    await page.goto(configureUrl(accountId));
    const section = page.getByRole("region", {
      name: "Update your accounts from Stremio",
    });
    await expect(
      section.getByRole("button", { name: "Link Stremio", exact: true }),
    ).toBeVisible();
    await section
      .getByRole("button", { name: "Stop sharing", exact: true })
      .click();
    await section
      .getByRole("button", { name: "Stop sharing", exact: true })
      .click();
    await expect
      .poll(async () => (await getWatchRows(accountId)).tracking)
      .toBeNull();
    await expect(
      section.getByRole("button", { name: "Stop sharing", exact: true }),
    ).toHaveCount(0);
  },
);

test(
  "a Simkl title held by another worker waits without using a failure attempt",
  { tag: "@local" },
  async () => {
    const accountId = await seedAccount();
    await seedConnection(accountId, "simkl");
    await seedStremioLink(accountId, AUTH_KEY);
    writeStremio({ authKey: AUTH_KEY, trakt: false, library: [], addons: [] });
    expect(
      (
        await call(`/${accountId}/watch-tracking`, {
          method: "PUT",
          json: {
            consent: true,
            destinations: [],
            watchlistDestinations: ["simkl"],
          },
        })
      ).status,
    ).toBe(200);
    await call(`/${accountId}/library/movie/${MOVIE}/action=libraryAdd.json`);
    await withHeldSimklWrite(accountId, MOVIE, async () => {
      expect((await runCron()).simkl).toMatchObject({ sent: 0, failed: 0 });
      const pending = (await getWatchRows(accountId)).writes;
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        kind: "watchlist",
        attempts: 0,
        first_failed_at: null,
        lease_token: null,
      });
      expect(Date.parse(pending[0].due_at)).toBeGreaterThan(Date.now());
      expect(watchedWrites("api.simkl.com", "/sync/add-to-list")).toEqual([]);
    });
    expect(
      (await call(`/${accountId}/watch-tracking/retry`, { method: "POST" }))
        .status,
    ).toBe(200);
    expect((await runCron()).simkl?.sent).toBe(1);
    expect((await getWatchRows(accountId)).writes).toEqual([]);
    expect(watchedWrites("api.simkl.com", "/sync/add-to-list")).toHaveLength(1);
  },
);
