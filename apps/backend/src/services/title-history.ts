import { sourceKey } from "@stremlist/shared/list-merge";
import type { SourceId } from "@stremlist/shared/providers";
import { sourceRequiresConnection } from "@stremlist/shared/providers";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  connectionPrefix,
  isPreconditionFailed,
  readJsonVersion,
  writeJson,
} from "../lib/r2-json";

/*
 * The detection history of each Source list (ADR 0007), one R2 object per
 * Account and Source list (ADR 0008). The rules that compare two
 * synchronizations and that list the new Titles are pure functions, so they
 * are tested without storage.
 */

const HISTORY_FORMAT_VERSION = 1;

/**
 * A removed entry is forgotten this long after its removal, so the history
 * of a Source list that changes a lot (a chart) stops growing. An entry that
 * comes back after that is new again.
 */
export const REMOVED_ENTRY_RETENTION_MS = 180 * 24 * 60 * 60_000;

/** Conditional writes that lose a race to another instance are tried again. */
const MAX_WRITE_ATTEMPTS = 4;

const historySchema = z.object({
  version: z.literal(HISTORY_FORMAT_VERSION),
  source: z.string(),
  /** The first complete synchronization: its entries are the Baseline. */
  baselineAt: z.string(),
  /** The latest complete synchronization, which the next one is compared with. */
  lastSyncAt: z.string(),
  /**
   * For a Source list that only a Connection can read: the Connection whose
   * Provider user the history belongs to. Another user, or a new Connection
   * after a disconnect, means another history.
   */
  connection: z
    .object({ user: z.string().nullable(), connectedAt: z.string() })
    .nullable(),
  /**
   * Entry key → [IMDb ID (null: Unresolved), detection date (null: in the
   * Baseline), removal date (null: present)].
   */
  entries: z.record(
    z.tuple([
      z.string().nullable(),
      z.string().nullable(),
      z.string().nullable(),
    ]),
  ),
});

export type SourceHistory = z.infer<typeof historySchema>;

/** The Connection that a Connection-only history must belong to. */
export interface HistoryConnection {
  user: string | null;
  connectedAt: string;
}

/** One entry of a complete synchronization. */
export interface KeyedEntry {
  key: string;
  imdbId: string | null;
}

export function historyKey(accountId: string, source: SourceId): string {
  const hash = createHash("sha256")
    .update(sourceKey(source))
    .digest("hex")
    .slice(0, 16);
  // Under the Connection's prefix, a disconnect deletes it with the rest.
  return sourceRequiresConnection(source.provider, source.sourceRef)
    ? `${connectionPrefix(accountId, source.provider)}history/${hash}.json`
    : `history/${accountId}/${hash}.json`;
}

/** The R2 prefix of an Account's histories that need no Connection. */
export function accountHistoryPrefix(accountId: string): string {
  return `history/${accountId}/`;
}

/** The same Connection; dates compare as times (Postgres keeps microseconds). */
function sameConnection(
  a: HistoryConnection | null,
  b: HistoryConnection | null,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.user === b.user && Date.parse(a.connectedAt) === Date.parse(b.connectedAt)
  );
}

/**
 * Whether a stored history may still be used: a Connection-only one only
 * while the same Connection exists (`current`).
 */
export function historyApplies(
  history: SourceHistory,
  source: SourceId,
  current: HistoryConnection | null,
): boolean {
  if (history.source !== sourceKey(source)) return false;
  if (!sourceRequiresConnection(source.provider, source.sourceRef)) return true;
  return current !== null && sameConnection(history.connection, current);
}

/** One pair per entry key; a resolved entry wins over an unresolved one. */
function uniqueEntries(entries: KeyedEntry[]): Map<string, string | null> {
  const unique = new Map<string, string | null>();
  for (const { key, imdbId } of entries) {
    const known = unique.get(key);
    if (
      known === undefined ||
      (imdbId !== null && (known === null || imdbId < known))
    ) {
      unique.set(key, imdbId);
    }
  }
  return unique;
}

export interface SynchronizationResult {
  history: SourceHistory;
  /** New entries: 0 for the Baseline. */
  added: number;
  /** Whether anything but the synchronization date changed. */
  changed: boolean;
}

/**
 * Compare a complete synchronization with the stored history. Null when a
 * synchronization that started later is already recorded: a slow read must
 * not undo a newer one. `previous` must already be checked with
 * `historyApplies`; pass null to start a Baseline.
 */
export function applySynchronization(
  previous: SourceHistory | null,
  source: SourceId,
  entries: KeyedEntry[],
  syncedAt: Date,
  connection: HistoryConnection | null,
): SynchronizationResult | null {
  const at = syncedAt.toISOString();
  const current = uniqueEntries(entries);

  if (!previous) {
    return {
      history: {
        version: HISTORY_FORMAT_VERSION,
        source: sourceKey(source),
        baselineAt: at,
        lastSyncAt: at,
        connection,
        entries: Object.fromEntries(
          [...current].map(([key, imdbId]) => [key, [imdbId, null, null]]),
        ),
      },
      added: 0,
      changed: true,
    };
  }
  if (syncedAt.getTime() <= Date.parse(previous.lastSyncAt)) return null;

  const forgetBefore = syncedAt.getTime() - REMOVED_ENTRY_RETENTION_MS;
  const next: SourceHistory["entries"] = {};
  let changed = false;
  let added = 0;
  for (const [key, [imdbId, detectedAt, removedAt]] of Object.entries(
    previous.entries,
  )) {
    if (current.has(key)) {
      // Back, or resolved since: the detection date never changes.
      const resolved = current.get(key) ?? imdbId;
      if (removedAt !== null || resolved !== imdbId) changed = true;
      next[key] = [resolved, detectedAt, null];
    } else if (removedAt === null) {
      // Gone: marked, so an entry that comes back keeps its detection.
      next[key] = [imdbId, detectedAt, at];
      changed = true;
    } else if (Date.parse(removedAt) >= forgetBefore) {
      next[key] = [imdbId, detectedAt, removedAt];
    } else {
      changed = true;
    }
  }
  for (const [key, imdbId] of current) {
    if (key in next) continue;
    next[key] = [imdbId, at, null];
    added += 1;
    changed = true;
  }

  return {
    history: { ...previous, lastSyncAt: at, entries: next },
    added,
    changed,
  };
}

/** A Title of the "New titles" catalog, with the Source list that has it. */
export interface NewTitle {
  imdbId: string;
  source: SourceId;
  detectedAt: string;
}

interface TitleInSource {
  source: SourceId;
  detectedAt: string | null;
  inBaseline: boolean;
  present: boolean;
}

/**
 * The new Titles of these histories, one per Title with its earliest
 * detection, newest first. Within one Source list a Title is new only when
 * none of its entries is in the Baseline (an entry whose key changed is
 * still the same Title). It is shown while one of the Source lists where it
 * is new still has it. Its date is the first appearance of its first
 * detected entry, whatever happened after.
 */
export function listNewTitles(
  histories: { source: SourceId; history: SourceHistory }[],
  limit: number,
): NewTitle[] {
  const titles = new Map<string, TitleInSource[]>();
  for (const { source, history } of histories) {
    const perTitle = new Map<string, TitleInSource>();
    for (const [imdbId, detectedAt, removedAt] of Object.values(
      history.entries,
    )) {
      if (imdbId === null) continue;
      const known = perTitle.get(imdbId) ?? {
        source,
        detectedAt: null,
        inBaseline: false,
        present: false,
      };
      if (detectedAt === null) known.inBaseline = true;
      else if (known.detectedAt === null || detectedAt < known.detectedAt) {
        known.detectedAt = detectedAt;
      }
      if (removedAt === null) known.present = true;
      perTitle.set(imdbId, known);
    }
    for (const [imdbId, title] of perTitle) {
      if (title.inBaseline) continue;
      titles.set(imdbId, [...(titles.get(imdbId) ?? []), title]);
    }
  }

  const found: NewTitle[] = [];
  for (const [imdbId, sources] of titles) {
    if (!sources.some((title) => title.present)) continue;
    // The earliest detection, also from a Source list that dropped it since:
    // removing it from one List must not give it a later date.
    const earliest = sources.reduce((best, title) =>
      compareDetections(title, best) < 0 ? title : best,
    );
    if (earliest.detectedAt === null) continue;
    found.push({
      imdbId,
      source: earliest.source,
      detectedAt: earliest.detectedAt,
    });
  }
  return found
    .sort(
      (a, b) =>
        b.detectedAt.localeCompare(a.detectedAt) ||
        a.imdbId.localeCompare(b.imdbId),
    )
    .slice(0, Math.max(limit, 0));
}

function compareDetections(a: TitleInSource, b: TitleInSource): number {
  return (
    (a.detectedAt ?? "").localeCompare(b.detectedAt ?? "") ||
    a.source.provider.localeCompare(b.source.provider) ||
    a.source.sourceRef.localeCompare(b.source.sourceRef)
  );
}

interface StoredVersion {
  history: SourceHistory | null;
  etag: string | null;
}

async function readStored(key: string): Promise<StoredVersion> {
  const stored = await readJsonVersion(key);
  if (!stored) return { history: null, etag: null };
  const parsed = historySchema.safeParse(stored.value);
  // A history that cannot be read starts a new Baseline over it.
  return {
    history: parsed.success ? parsed.data : null,
    etag: stored.etag ?? null,
  };
}

/** The stored history of a Source list, or null. Errors throw. */
export async function readHistory(
  accountId: string,
  source: SourceId,
): Promise<SourceHistory | null> {
  return (await readStored(historyKey(accountId, source))).history;
}

/**
 * Record a complete synchronization. Returns the number of new entries
 * (0 for a Baseline), or null when a newer synchronization is already
 * recorded. `connection` is the Connection the read went through, for a
 * Source list that only a Connection can read. Errors throw.
 */
export async function recordHistory(
  accountId: string,
  source: SourceId,
  entries: KeyedEntry[],
  syncedAt: Date,
  connection: HistoryConnection | null,
): Promise<number | null> {
  const key = historyKey(accountId, source);
  for (let attempt = 1; ; attempt++) {
    const stored = await readStored(key);
    const previous =
      stored.history && historyApplies(stored.history, source, connection)
        ? stored.history
        : null;
    const result = applySynchronization(
      previous,
      source,
      entries,
      syncedAt,
      connection,
    );
    if (!result) return null;
    try {
      // Even unchanged reads must advance the timestamp: an older read on
      // another instance may still contain a title that disappeared since.
      await writeJson(key, result.history, { etag: stored.etag });
      return result.added;
    } catch (error) {
      // Another instance wrote in between: compare with its version.
      if (!isPreconditionFailed(error) || attempt >= MAX_WRITE_ATTEMPTS) {
        throw error;
      }
    }
  }
}
