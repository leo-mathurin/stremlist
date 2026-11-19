import type { TitleType } from "@stremlist/shared/constants";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { http, HttpResponse } from "msw";
import { expect, vi } from "vite-plus/test";
import { z } from "zod";

import app from "../../index.js";
import { mapList } from "../../services/list-rows";
import { sourceCaches } from "../../services/merged-lists";
import type { SourceHistory } from "../../services/title-history";
import { historyKey } from "../../services/title-history";
import { LIST_IDS, movie, seedAccount, seedList } from "./account.fixture.js";
import {
  cinemetaWithoutTitles,
  FakeImdb,
  IMDB_GRAPHQL,
} from "./imdb.test-utils.js";
import { configBody, metasBody, parseJson, readJson } from "./json.js";
import { cache } from "./list-cache.test-utils.js";
import { db, resetRpc } from "./mock-supabase.js";
import { r2Objects, resetR2 } from "./r2.test-utils.js";
import { listRow } from "./rows.js";
import { FakeTrakt, TRAKT_API, useTraktApp } from "./trakt.test-utils.js";

const sourceHistory = z.object({
  version: z.literal(1),
  source: z.string(),
  baselineAt: z.string(),
  lastSyncAt: z.string(),
  connection: z
    .object({ user: z.string().nullable(), connectedAt: z.string() })
    .nullable(),
  entries: z.record(
    z.string(),
    z.tuple([
      z.string().nullable(),
      z.string().nullable(),
      z.string().nullable(),
    ]),
  ),
}) satisfies z.ZodType<SourceHistory>;

const FIRST_START = Date.parse("2026-10-01T12:00:00.000Z");
let testStart = FIRST_START;
let lastTime = FIRST_START;
/** More than the 30-minute freshness of IMDb and personal Trakt lists. */
export const NEXT_SYNC_MS = 31 * 60_000;
export const DAY_MS = 24 * 60 * 60_000;

export function series(id: string) {
  return movie(id, { type: "series", name: `Series ${id}` });
}

/** The IMDb GraphQL API and the Trakt API that the Source lists live on. */
export const imdb = new FakeImdb();
export const trakt = new FakeTrakt();

type SourceProvider = "imdb" | "trakt";

const down = new Set<string>();
let onRead: (() => void) | null = null;

/** Runs `hook` once, when the next Source list read reaches its Provider. */
export function duringNextRead(hook: () => void) {
  onRead = hook;
}

function startRead() {
  const hook = onRead;
  onRead = null;
  hook?.();
}

const imdbBody = z.object({
  operationName: z.string(),
  variables: z.record(z.string(), z.unknown()),
});

function imdbRef(variables: Record<string, unknown>) {
  const ref = variables.urConst ?? variables.listId;
  return typeof ref === "string" ? ref : null;
}

/**
 * The MSW handlers of the Providers: IMDb, Trakt, Cinemeta, and Trakt's
 * token revocation on disconnect. A Source list that is down answers 503.
 */
export function newTitlesHandlers() {
  return [
    http.post(IMDB_GRAPHQL, async ({ request }) => {
      const { operationName, variables } = imdbBody.parse(
        await request.clone().json(),
      );
      if (operationName.endsWith("Page")) {
        const ref = imdbRef(variables);
        if (ref && down.has(`imdb:${ref}`)) {
          return new HttpResponse(null, { status: 503 });
        }
        startRead();
      }
      return imdb.answer(request);
    }),
    http.all(`${TRAKT_API}/*`, ({ request }) => {
      const path = new URL(request.url).pathname;
      if (
        request.method === "GET" &&
        [...down].some(
          (key) => key.startsWith("trakt:") && path === key.slice(6),
        )
      ) {
        return new HttpResponse(null, { status: 503 });
      }
      if (request.method === "GET" && trakt.paths.has(path)) startRead();
      return trakt.answer(request);
    }),
    http.post("https://auth.trakt.tv/oauth/revoke", () =>
      HttpResponse.json({}),
    ),
    cinemetaWithoutTitles,
  ];
}

function traktPaths(sourceRef: string) {
  if (sourceRef === "me/history") {
    return ["/users/me/watched/movies", "/users/me/watched/shows"];
  }
  if (sourceRef.startsWith("smart-lists/")) return [`/${sourceRef}/items`];
  return [`/${sourceRef}`];
}

function serve(
  provider: SourceProvider,
  sourceRef: string,
  metas: StremioMeta[],
) {
  for (const meta of metas) imdb.titles.set(meta.id, meta);
  if (provider === "imdb") {
    (sourceRef.startsWith("ls") ? imdb.lists : imdb.watchlists).set(
      sourceRef,
      metas,
    );
    return;
  }
  const [movies, shows = movies] = traktPaths(sourceRef);
  if (movies === shows) {
    trakt.serve(movies, metas);
    return;
  }
  trakt.serve(
    movies,
    metas.filter((meta) => meta.type === "movie"),
  );
  trakt.serve(
    shows,
    metas.filter((meta) => meta.type === "series"),
  );
}

const DEFAULT_REFS: Record<SourceProvider, string> = {
  imdb: "ur1",
  trakt: "users/leo/watchlist",
};

/**
 * A Source list the test changes between synchronizations: `metas` is what
 * its Provider serves; while `down`, the Provider answers 503.
 */
export function sourceList(
  provider: SourceProvider,
  initial: StremioMeta[],
  sourceRef = DEFAULT_REFS[provider],
) {
  const key =
    provider === "imdb"
      ? `imdb:${sourceRef}`
      : `trakt:${traktPaths(sourceRef)[0]}`;
  let metas = initial;
  serve(provider, sourceRef, metas);
  return {
    get metas() {
      return metas;
    },
    set metas(next: StremioMeta[]) {
      metas = next;
      serve(provider, sourceRef, metas);
    },
    get down() {
      return down.has(key);
    },
    set down(value: boolean) {
      if (value) down.add(key);
      else down.delete(key);
    },
  };
}

const SMART_LIST_ITEMS = 1000;

/**
 * Serves the Trakt smart list `sourceRef` with these Titles and enough
 * others after them that the read stops at Trakt's 1,000-item cap, so the
 * read is not complete.
 */
export function serveCutSmartList(sourceRef: string, metas: StremioMeta[]) {
  const others = Array.from(
    { length: SMART_LIST_ITEMS + 1 - metas.length },
    (_, index) => movie(`tt${String(9_000_000 + index)}`),
  );
  serve("trakt", sourceRef, [...metas, ...others]);
}

export let accountId = "";

export function seedNewTitlesAccount(enabled = true) {
  accountId = seedAccount({ new_titles_catalog: enabled }).id;
}

/** An Account with one IMDb List, LIST_IDS[0] on `ur1`. */
export function seedImdbList(enabled = true) {
  seedNewTitlesAccount(enabled);
  seedList(accountId, { id: LIST_IDS[0], source_ref: "ur1" });
}

function cacheKeysOf(listId: string) {
  return db
    .getTable("lists")
    .filter((row) => row.id === listId)
    .flatMap((row) => {
      const list = mapList(listRow.parse(row));
      return list ? sourceCaches(list).map(({ cacheKey }) => cacheKey) : [];
    });
}

/** Stremio asks for a List catalog after its cache went stale. */
export async function sync(listId: string, type: TitleType = "movie") {
  vi.setSystemTime(Date.now() + NEXT_SYNC_MS);
  for (const key of cacheKeysOf(listId)) cache.markStale(key);
  const res = await app.request(
    `/${accountId}/catalog/${type}/wl-${listId}-${type}.json`,
  );
  expect(res.status).toBe(200);
}

export async function newTitles(type: TitleType = "movie", key = accountId) {
  const res = await app.request(
    `/${key}/catalog/${type}/new-titles-${type}.json`,
  );
  expect(res.status).toBe(200);
  return (await readJson(res, metasBody)).metas;
}

export function ids(metas: StremioMeta[]) {
  return metas.map((meta) => meta.id);
}

function storedHistories() {
  return [...r2Objects]
    .filter(([key]) =>
      /^(history\/|connections\/[^/]+\/[^/]+\/history\/)/u.test(key),
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, body]) => {
      const history = parseJson(body, sourceHistory);
      const [provider, ...ref] = history.source.split(":");
      return {
        account_id: key.split("/")[1],
        provider,
        source_ref: ref.join(":"),
        history,
      };
    });
}

/** One row per stored Source list history, like the old table. */
export function syncRows() {
  return storedHistories()
    .map(({ account_id, provider, source_ref, history }) => ({
      account_id,
      provider,
      source_ref,
      baseline_at: history.baselineAt,
      last_complete_sync_at: history.lastSyncAt,
      requires_connection: history.connection !== null,
      connection_user: history.connection?.user ?? null,
    }))
    .sort((a, b) => a.source_ref.localeCompare(b.source_ref));
}

/** One row per entry of every stored history, like the old table. */
export function detectionRows() {
  return storedHistories().flatMap(
    ({ account_id, provider, source_ref, history }) =>
      Object.entries(history.entries).map(
        ([entry_key, [imdb_id, detected_at, removed_at]]) => ({
          account_id,
          provider,
          source_ref,
          entry_key,
          imdb_id,
          detected_at,
          removed_at,
        }),
      ),
  );
}

export async function summary() {
  const res = await app.request(`/${accountId}/config`);
  expect(res.status).toBe(200);
  return (await readJson(res, configBody)).newTitles;
}

/**
 * A synchronized Source list whose entry `imdbId` was detected now. With a
 * `connectionUser`, the history belongs to that user of the Account's
 * Connection to the Provider, as it was when the history was written.
 */
export function seedHistory(
  provider: "imdb" | "trakt",
  sourceRef: string,
  imdbId: string,
  connectionUser: string | null = null,
) {
  const at = new Date().toISOString();
  const connection = db
    .getTable("connections")
    .find((row) => row.account_id === accountId && row.provider === provider);
  const history: SourceHistory = {
    version: 1,
    source: `${provider}:${sourceRef}`,
    baselineAt: at,
    lastSyncAt: at,
    connection:
      connectionUser === null
        ? null
        : {
            user: connectionUser,
            connectedAt:
              typeof connection?.created_at === "string"
                ? connection.created_at
                : at,
          },
    entries: { [`imdb:${imdbId}`]: [imdbId, at, null] },
  };
  r2Objects.set(
    historyKey(accountId, { provider, sourceRef }),
    JSON.stringify(history),
  );
}

export function setAccountId(id: string) {
  accountId = id;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * The date `days` after the start of the current test, as a detection names
 * it, for example `3 Oct 2026`. Each test starts on a later day than the
 * last time of the test before, so the Provider rate limiters of the app
 * never see the clock go back.
 */
export function testDay(days = 0) {
  const date = new Date(testStart + days * DAY_MS);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function resetNewTitlesTest() {
  db.reset();
  resetR2();
  resetRpc();
  cache.reset();
  imdb.reset();
  trakt.reset();
  down.clear();
  onRead = null;
  useTraktApp();
  testStart =
    lastTime === FIRST_START
      ? FIRST_START
      : FIRST_START + Math.ceil((lastTime - FIRST_START) / DAY_MS + 1) * DAY_MS;
  lastTime = testStart;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(testStart);
}

export function restoreNewTitlesTest() {
  lastTime = Math.max(lastTime, Date.now());
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
}
