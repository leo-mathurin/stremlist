/**
 * Shared setup for the New titles tests: fake Source lists that change
 * between synchronizations, and requests that read the New titles catalog.
 */
import type { TitleType } from "@stremlist/shared/constants";
import type {
  AccountConfigResponse,
  StremioMeta,
} from "@stremlist/shared/stremio.types";
import { expect, vi } from "vitest";

import app from "../../index.js";
import type { SourceEntry, SourceSnapshot } from "../../providers/types";
import type { SourceHistory } from "../../services/title-history";
import { historyKey } from "../../services/title-history";
import { LIST_IDS, movie, seedAccount, seedList } from "./fixtures.js";
import { cache } from "./mock-list-cache.js";
import { r2Objects, r2Unreadable } from "./mock-r2.js";
import {
  fakeAdapter,
  resetProviders,
  useFakeProvider,
} from "./mock-registry.js";
import { db, resetRpc } from "./mock-supabase.js";

const START = new Date("2026-10-01T12:00:00.000Z");
/** More than the fake adapters' 30-minute freshness. */
export const NEXT_SYNC_MS = 31 * 60_000;
export const DAY_MS = 24 * 60 * 60_000;

export function series(id: string): StremioMeta {
  return movie(id, { type: "series", name: `Series ${id}` });
}

export function entry(meta: StremioMeta): SourceEntry {
  return { imdbId: meta.id, meta };
}

/**
 * A Source list the test changes between synchronizations. `read` decides
 * what the next read returns; by default every entry, complete.
 */
export function sourceList(provider: "imdb" | "trakt", initial: StremioMeta[]) {
  const state = {
    metas: initial,
    read: null as null | (() => SourceSnapshot),
  };
  useFakeProvider(
    fakeAdapter(provider, {
      fetchSource: () =>
        Promise.resolve(
          state.read?.() ?? {
            entries: structuredClone(state.metas).map(entry),
            complete: true,
          },
        ),
    }),
  );
  return state;
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

/** Stremio asks for a List catalog after its cache went stale. */
export async function sync(listId: string, type: TitleType = "movie") {
  vi.setSystemTime(Date.now() + NEXT_SYNC_MS);
  const res = await app.request(
    `/${accountId}/catalog/${type}/wl-${listId}-${type}.json`,
  );
  expect(res.status).toBe(200);
}

export async function newTitles(
  type: TitleType = "movie",
  key = accountId,
): Promise<StremioMeta[]> {
  const res = await app.request(
    `/${key}/catalog/${type}/new-titles-${type}.json`,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { metas: StremioMeta[] }).metas;
}

export function ids(metas: StremioMeta[]): string[] {
  return metas.map((meta) => meta.id);
}

/** The stored histories (ADR 0008), with the Account and Source list. */
function storedHistories() {
  return [...r2Objects]
    .filter(([key]) =>
      /^(history\/|connections\/[^/]+\/[^/]+\/history\/)/u.test(key),
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, body]) => {
      const history = JSON.parse(body) as SourceHistory;
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
  return ((await res.json()) as AccountConfigResponse).newTitles;
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

export function resetNewTitlesTest() {
  db.reset();
  r2Objects.clear();
  r2Unreadable.clear();
  resetRpc();
  cache.reset();
  resetProviders();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}

export function restoreNewTitlesTest() {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}
