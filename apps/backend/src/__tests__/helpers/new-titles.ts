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
import { LIST_IDS, movie, seedAccount, seedList } from "./fixtures.js";
import { cache } from "./mock-list-cache.js";
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

export function detectionRows() {
  return db.getTable("source_list_entries");
}

export async function summary() {
  const res = await app.request(`/${accountId}/config`);
  expect(res.status).toBe(200);
  return ((await res.json()) as AccountConfigResponse).newTitles;
}

/** A synchronized Source list whose entry `imdbId` was detected now. */
export function seedHistory(
  provider: "imdb" | "trakt",
  sourceRef: string,
  imdbId: string,
  connectionUser: string | null = null,
) {
  const at = new Date().toISOString();
  const key = { account_id: accountId, provider, source_ref: sourceRef };
  db.insert("source_list_syncs", {
    ...key,
    baseline_at: at,
    last_complete_sync_at: at,
    requires_connection: connectionUser !== null,
    connection_user: connectionUser,
  });
  db.insert("source_list_entries", {
    ...key,
    entry_key: `imdb:${imdbId}`,
    imdb_id: imdbId,
    detected_at: at,
  });
}

export function setAccountId(id: string) {
  accountId = id;
}

export function resetNewTitlesTest() {
  db.reset();
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
