import type {
  CatalogPreview,
  CatalogPreviewResponse,
  CatalogPreviewRow,
  PreviewSourceProblem,
  PreviewUnresolvedEntry,
} from "@stremlist/shared/catalog-preview";
import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import type { DisplayMode } from "@stremlist/shared/constants";
import type { ListSource } from "@stremlist/shared/list-merge";
import { listSources, sourceKey } from "@stremlist/shared/list-merge";
import { listCatalogs } from "@stremlist/shared/manifest-catalogs";
import type { ProviderId } from "@stremlist/shared/providers";
import { PROVIDERS } from "@stremlist/shared/providers";
import { createHash } from "node:crypto";
import { getProvider, isProviderEnabled } from "../providers/registry";
import type { ConnectionAccess, SourceEntry } from "../providers/types";
import { SourceUnavailableError } from "../providers/types";
import { filterCatalog, resolveCatalogSelection } from "./catalog-filters";
import { sortCatalog } from "./catalog-sort";
import type { BuiltCatalog } from "./lists";
import { buildCatalog, providerContext, sourceProblemReason } from "./lists";
import { mergeListCatalogs } from "./merged-lists";

/**
 * How long one read of a Source list serves previews. Changing the sort or
 * the filters of a List asks for a new preview each time: it must not read
 * the Provider again.
 */
const READING_TTL_MS = 5 * 60_000;
/** A read that left entries unchecked is read again sooner. */
const UNFINISHED_READING_TTL_MS = 30_000;
const MAX_READINGS = 50;
/** Most Titles that a preview shows for each Catalog. */
const TITLES_PER_CATALOG = 12;
/** Most Unresolved entries that a preview lists. */
const UNRESOLVED_LIMIT = 50;

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
}

interface Reading {
  built: Promise<BuiltCatalog>;
  expiresAt: number;
}

const readings = new Map<string, Reading>();

/** Forget every cached read (tests). */
export function resetPreviewReadings(): void {
  readings.clear();
}

/**
 * Identifies one authorization of a Connection: connecting again (maybe as
 * another Provider user) or a token refresh gives a new one.
 */
async function connectionScope(connection: ConnectionAccess): Promise<string> {
  const token = await connection.getAccessToken();
  const fingerprint = createHash("sha256")
    .update(token)
    .digest("base64url")
    .slice(0, 16);
  return `account:${connection.accountId}:${fingerprint}`;
}

/**
 * Read one Source list of a List, or reuse a recent read. A read through a
 * Connection can hold private Titles, so it is keyed by Account and by the
 * Connection's current authorization: it never serves another Account, a
 * request without the Connection, or a later Connection of the same Account.
 */
async function readSource(
  request: ListSource & { connectionAccountId: string | null },
): Promise<BuiltCatalog> {
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
  if (cached && cached.expiresAt > Date.now()) return cached.built;

  const built = buildCatalog(getProvider(request.provider), request, ctx);
  const reading: Reading = { built, expiresAt: Date.now() + READING_TTL_MS };
  readings.delete(key);
  readings.set(key, reading);
  // One read is added at a time: dropping the oldest keeps the limit.
  if (readings.size > MAX_READINGS) {
    const [oldest] = readings.keys();
    readings.delete(oldest);
  }
  built.then(
    (result) => {
      if (result.deferred > 0) {
        reading.expiresAt = Math.min(
          reading.expiresAt,
          Date.now() + UNFINISHED_READING_TTL_MS,
        );
      }
    },
    () => {
      if (readings.get(key) === reading) readings.delete(key);
    },
  );
  return built;
}

/** A page where the user can check an Unresolved entry, when one is known. */
function entryUrl(entry: SourceEntry): string | null {
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
export function previewPoster(poster: string | null): string | null {
  if (!poster) return null;
  const match = IMDB_IMAGE.exec(poster);
  return match ? `${match[1]}._V1_QL75_UX240_.${match[2]}` : poster;
}

function toUnresolvedEntry(entry: SourceEntry): PreviewUnresolvedEntry {
  return {
    title: entry.title ?? entry.originalTitle ?? null,
    year: entry.year ?? null,
    type: entry.type ?? entry.externalIds?.tmdb?.type ?? null,
    url: entryUrl(entry),
  };
}

/**
 * The Catalogs that a List adds to Stremio, each with its first Titles. Uses
 * the same Catalogs, sort and filters as the manifest and the catalog route,
 * so the preview matches what Stremio shows (RPDB posters aside). A merged
 * List shows the Titles of the Source lists it could read once each, like
 * its Catalog.
 */
function presentPreview(
  request: PreviewRequest,
  read: BuiltCatalog[],
  sourceProblems: PreviewSourceProblem[],
): CatalogPreview {
  const metas = mergeListCatalogs(
    request,
    read.map((built) => built.data.metas),
  );
  const unresolvedEntries = read.flatMap((built) => built.unresolvedEntries);
  // The real Catalog seeds Shuffle with its cache generation; a preview has
  // none, so it uses a stable seed of its own.
  const generation = `preview:${listSources(request).map(sourceKey).join(",")}`;

  const catalogs = listCatalogs(request).map(
    ({ type, preset }): CatalogPreviewRow => {
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
    },
  );

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
 * and fails only when none can be read.
 */
export async function previewList(
  request: PreviewRequest,
): Promise<CatalogPreviewResponse> {
  const sources = listSources(request);
  const results = await Promise.allSettled(
    sources.map((source) =>
      readSource({
        ...source,
        connectionAccountId: request.connectionAccountId,
      }),
    ),
  );
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
