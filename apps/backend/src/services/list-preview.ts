import type {
  CatalogPreviewResponse,
  PreviewSourceProblem,
} from "@stremlist/shared/catalog-preview";
import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import type { DisplayMode } from "@stremlist/shared/constants";
import type { ListSource } from "@stremlist/shared/list-merge";
import { listSources, sourceKey } from "@stremlist/shared/list-merge";
import { listCatalogs } from "@stremlist/shared/manifest-catalogs";
import { QUEUE_STATE_MIN_MS } from "@stremlist/shared/provider-queue";
import type { ProviderId } from "@stremlist/shared/providers";
import { PROVIDERS } from "@stremlist/shared/providers";
import { createHash } from "node:crypto";
import { LruCache } from "../lib/lru";
import type { ReadQueue } from "../providers/read-priority";
import { readQueue, withReadPriority } from "../providers/read-priority";
import { getProvider, isProviderEnabled } from "../providers/registry";
import type { ConnectionAccess, SourceEntry } from "../providers/types";
import { SourceBusyError, SourceUnavailableError } from "../providers/types";
import { findPosters } from "../titles/title-posters";
import { filterCatalog, resolveCatalogSelection } from "./catalog-filters";
import { sortCatalog } from "./catalog-sort";
import type { BuiltCatalog } from "./lists";
import { buildCatalog, providerContext, sourceProblemReason } from "./lists";
import { mergeListCatalogs } from "./merged-lists";
import { queuedAnswer } from "./source-links";

const READING_TTL_MS = 5 * 60_000;
const UNFINISHED_READING_TTL_MS = 30_000;
const MAX_READINGS = 50;
const MAX_READINGS_WEIGHT = 16 * 1024 * 1024;
const TITLES_PER_CATALOG = 12;
const UNRESOLVED_LIMIT = 50;
const PREVIEW_WAIT_MS = 10_000;
const PREVIEW_POSTER_BUDGET_MS = 3_000;

export interface PreviewRequest {
  provider: ProviderId;
  sourceRef: string;
  /** The other Source lists of a merged List (ADR 0006). */
  mergedSources?: ListSource[];
  /**
   * The Account whose Connection the read may use, or null: a new setup or a
   * Legacy alias reads public Source lists only (ADR 0001).
   */
  connectionAccountId: string | null;
  sortOption: string;
  /** Absent: split, like a List saved without one. */
  displayMode?: DisplayMode;
  catalogSettings?: CatalogSettings;
  /** The place in a Provider's queue from a queued answer. */
  ticket?: string | null;
}

interface Reading {
  built: Promise<BuiltCatalog>;
  expiresAt: number;
}

const readings = new LruCache<string, Reading>({
  maxEntries: MAX_READINGS,
  maxWeight: MAX_READINGS_WEIGHT,
});

function readingWeight(built: BuiltCatalog) {
  let weight = built.snapshot.entries.length * 200;
  for (const meta of built.data.metas) {
    weight +=
      300 +
      meta.name.length +
      meta.description.length +
      (meta.poster?.length ?? 0);
  }
  return weight;
}

/** Forget every cached read (tests). */
export function resetPreviewReadings() {
  readings.clear();
}

async function connectionScope(connection: ConnectionAccess) {
  const token = await connection.getAccessToken();
  const fingerprint = createHash("sha256")
    .update(token)
    .digest("base64url")
    .slice(0, 16);
  return `account:${connection.accountId}:${fingerprint}`;
}

async function readSource(
  request: ListSource & { connectionAccountId: string | null },
  queue: ReadQueue,
) {
  if (PROVIDERS[request.provider].availability !== "available") {
    throw new SourceUnavailableError(
      "coming_soon",
      `${request.provider} is not available yet`,
    );
  }
  if (!isProviderEnabled(request.provider)) {
    throw new SourceUnavailableError(
      "disabled",
      `${request.provider} is turned off`,
    );
  }
  const ctx = await providerContext(request, request.connectionAccountId);
  const scope = ctx.connection
    ? await connectionScope(ctx.connection)
    : "public";
  const key = `${scope}:${request.provider}:${request.sourceRef}`;

  const cached = readings.get(key);
  if (cached) return cached.built;

  const built = withReadPriority(
    "interactive",
    () => buildCatalog(getProvider(request.provider), request, ctx),
    queue,
  );
  const reading: Reading = { built, expiresAt: Date.now() + READING_TTL_MS };
  readings.set(key, reading, { ttlMs: READING_TTL_MS });
  built.then(
    (result) => {
      if (readings.get(key) !== reading) return;
      if (result.deferred > 0) {
        reading.expiresAt = Math.min(
          reading.expiresAt,
          Date.now() + UNFINISHED_READING_TTL_MS,
        );
      }
      readings.set(key, reading, {
        weight: readingWeight(result),
        ttlMs: reading.expiresAt - Date.now(),
      });
    },
    () => {
      if (readings.get(key) === reading) readings.delete(key);
    },
  );
  return built;
}

function entryUrl(entry: SourceEntry) {
  if (entry.sourceUrl) return entry.sourceUrl;
  const ids = entry.externalIds;
  if (ids?.justwatchPath)
    return `https://www.justwatch.com${ids.justwatchPath}`;
  if (ids?.tmdb) {
    return `https://www.themoviedb.org/${ids.tmdb.type === "series" ? "tv" : "movie"}/${ids.tmdb.id}`;
  }
  return null;
}

const IMDB_IMAGE =
  /^(https:\/\/m\.media-amazon\.com\/images\/M\/[^.]+)\._V1_[^/]*\.(jpg|png)$/u;

/** A poster small enough for a preview tile (IMDb images resize by URL). */
export function previewPoster(poster: string | null) {
  if (!poster) return null;
  const match = IMDB_IMAGE.exec(poster);
  return match ? `${match[1]}._V1_QL75_UX240_.${match[2]}` : poster;
}

function toUnresolvedEntry(entry: SourceEntry) {
  return {
    title: entry.title ?? entry.originalTitle ?? null,
    year: entry.year ?? null,
    type: entry.type ?? entry.externalIds?.tmdb?.type ?? null,
    url: entryUrl(entry),
  };
}

async function presentPreview(
  request: PreviewRequest,
  read: BuiltCatalog[],
  sourceProblems: PreviewSourceProblem[],
) {
  const metas = mergeListCatalogs(
    request,
    read.map((built) => built.data.metas),
  );
  const unresolvedEntries = read.flatMap((built) => built.unresolvedEntries);
  const generation = `preview:${listSources(request).map(sourceKey).join(",")}`;

  const catalogs = listCatalogs(request).map(({ type, preset }) => {
    const selection = resolveCatalogSelection(
      request.sortOption,
      request.catalogSettings,
      null,
      preset ?? undefined,
    );
    const matching = filterCatalog(
      sortCatalog(metas, selection.sort, generation).filter(
        (meta) => meta.type === type,
      ),
      selection.filters,
    );
    return {
      type,
      preset,
      total: matching.length,
      titles: matching.slice(0, TITLES_PER_CATALOG).map((meta) => ({
        id: meta.id,
        type: meta.type,
        name: meta.name,
        poster: previewPoster(meta.poster),
        releaseInfo: meta.releaseInfo ?? null,
      })),
    };
  });
  const shown = catalogs.flatMap((row) => row.titles);
  const options = {
    budgetMs: PREVIEW_POSTER_BUDGET_MS,
    size: "preview",
  } as const;
  const [tmdbPosters, tvdbPosters] = await Promise.all([
    findPosters("tmdb", shown, options),
    findPosters("tvdb", shown, options),
  ]);
  for (const title of shown) {
    title.tmdbPoster = tmdbPosters.get(title.id) ?? null;
    title.tvdbPoster = tvdbPosters.get(title.id) ?? null;
  }

  return {
    ok: true,
    titleCount: metas.length,
    typeCounts: {
      movie: metas.filter((meta) => meta.type === "movie").length,
      series: metas.filter((meta) => meta.type === "series").length,
    },
    catalogs,
    unresolved: {
      count: unresolvedEntries.length,
      notCheckedYet: read.reduce((sum, built) => sum + built.deferred, 0),
      entries: unresolvedEntries
        .slice(0, UNRESOLVED_LIMIT)
        .map(toUnresolvedEntry),
    },
    withoutDetails: read.reduce((sum, built) => sum + built.withoutMetadata, 0),
    ...(sourceProblems.length > 0 ? { sourceProblems } : {}),
  };
}

/**
 * Preview a List before it is saved: read its Source lists like a catalog
 * request would, but write no Catalog cache. Expected problems (private list,
 * missing Connection, Provider turned off) come back as a reason. A merged
 * List leaves out the Source lists that cannot be read, as its Catalog does,
 * and fails only when none can be read. When a Provider's queue is long (3 s
 * or more), the answer is the queue state: ask again with its ticket to keep
 * the place. The pages read so far stay cached, so the next request goes on
 * from there.
 */
export async function previewList(request: PreviewRequest) {
  const sources = listSources(request);
  const queue = readQueue({
    maxWaitMs: PREVIEW_WAIT_MS,
    answerAtMs: QUEUE_STATE_MIN_MS,
    ticket: request.ticket ?? null,
  });
  const results = await Promise.allSettled(
    sources.map((source) =>
      readSource(
        {
          ...source,
          connectionAccountId: request.connectionAccountId,
        },
        queue,
      ),
    ),
  );
  const busy = results.flatMap((result, index) =>
    result.status === "rejected" && result.reason instanceof SourceBusyError
      ? [{ error: result.reason, provider: sources[index].provider }]
      : [],
  );
  if (busy.length > 0) {
    const longest = busy.reduce((a, b) =>
      b.error.waitMs > a.error.waitMs ? b : a,
    );
    return {
      ...queuedAnswer(longest.error, longest.provider),
      ticket: longest.error.ticket ?? queue.ticket,
    };
  }
  const read: BuiltCatalog[] = [];
  const problems: PreviewSourceProblem[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      read.push(result.value);
      return;
    }
    const { provider, sourceRef } = sources[index];
    const reason = sourceProblemReason(result.reason);
    if (reason === "unavailable") {
      console.error(
        `Previewing ${provider} ${sourceRef} failed:`,
        result.reason instanceof Error ? result.reason.message : result.reason,
      );
    }
    problems.push({ provider, sourceRef, reason });
  });

  if (read.length === 0) {
    const [first] = problems;
    return {
      ok: false,
      reason: first.reason,
      ...(sources.length > 1
        ? { source: { provider: first.provider, sourceRef: first.sourceRef } }
        : {}),
    };
  }
  return presentPreview(request, read, problems);
}
