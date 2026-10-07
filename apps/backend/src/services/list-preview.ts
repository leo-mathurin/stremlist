import type {
  CatalogPreview,
  CatalogPreviewResponse,
  CatalogPreviewRow,
  PreviewUnresolvedEntry,
} from "@stremlist/shared/catalog-preview";
import {
  PREVIEW_TITLES_PER_CATALOG,
  PREVIEW_UNRESOLVED_LIMIT,
} from "@stremlist/shared/catalog-preview";
import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import { CATALOG_PRESETS } from "@stremlist/shared/catalog-settings";
import type { DisplayMode } from "@stremlist/shared/constants";
import { PROVIDERS } from "@stremlist/shared/providers";
import { createHash } from "node:crypto";
import { getProvider, isProviderEnabled } from "../providers/registry";
import type { ConnectionAccess, SourceEntry } from "../providers/types";
import { SourceUnavailableError } from "../providers/types";
import { filterCatalog, resolveCatalogSelection } from "./catalog-filters";
import { sortCatalog } from "./catalog-sort";
import { ConnectionExpiredError } from "./connections";
import type { BuiltCatalog, SourceAccess } from "./lists";
import { buildCatalog, providerContext } from "./lists";

/**
 * How long one read of a Source list serves previews. Changing the sort or
 * the filters of a List asks for a new preview each time: it must not read
 * the Provider again.
 */
const READING_TTL_MS = 5 * 60_000;
/** A read that left entries unchecked is read again sooner. */
const UNFINISHED_READING_TTL_MS = 30_000;
const MAX_READINGS = 50;

export interface PreviewRequest extends SourceAccess {
  sortOption: string;
  displayMode: DisplayMode;
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
 * Read the Source list of a List, or reuse a recent read. A read through a
 * Connection can hold private Titles, so it is keyed by Account and by the
 * Connection's current authorization: it never serves another Account, a
 * request without the Connection, or a later Connection of the same Account.
 */
async function readSource(request: PreviewRequest): Promise<BuiltCatalog> {
  const ctx = await providerContext(request);
  const scope = ctx.connection
    ? await connectionScope(ctx.connection)
    : "public";
  const key = `${scope}:${request.provider}:${request.sourceRef}`;

  const cached = readings.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.built;

  const built = buildCatalog(
    getProvider(request.provider),
    { provider: request.provider, sourceRef: request.sourceRef },
    ctx,
  );
  const reading: Reading = {
    built,
    expiresAt: Date.now() + READING_TTL_MS,
  };
  readings.delete(key);
  readings.set(key, reading);
  while (readings.size > MAX_READINGS) {
    const oldest = readings.keys().next().value;
    if (oldest === undefined) break;
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
 * the same sort and filters as the catalog route, so the preview matches what
 * Stremio shows (RPDB posters aside).
 */
export function presentPreview(
  request: Pick<
    PreviewRequest,
    "provider" | "sourceRef" | "sortOption" | "displayMode" | "catalogSettings"
  >,
  built: BuiltCatalog,
): CatalogPreview {
  const settings = request.catalogSettings ?? {};
  const types: ("movie" | "series")[] =
    request.displayMode === "movie" || request.displayMode === "series"
      ? [request.displayMode]
      : ["movie", "series"];
  const presets = CATALOG_PRESETS.filter((preset) =>
    settings.presets?.includes(preset.id),
  ).map((preset) => preset.id);
  // The real Catalog seeds Shuffle with its cache generation; a preview has
  // none, so it uses a stable seed of its own.
  const generation = `preview:${request.provider}:${request.sourceRef}`;

  const catalogs = types.flatMap((type) =>
    [null, ...presets].map((preset): CatalogPreviewRow => {
      const selection = resolveCatalogSelection(
        request.sortOption,
        settings,
        null,
        preset ?? undefined,
      );
      const matching = filterCatalog(
        sortCatalog(built.data.metas, selection.sort, generation).filter(
          (meta) => meta.type === type,
        ),
        selection.filters,
      );
      return {
        type,
        preset,
        total: matching.length,
        titles: matching.slice(0, PREVIEW_TITLES_PER_CATALOG).map((meta) => ({
          id: meta.id,
          type: meta.type,
          name: meta.name,
          poster: previewPoster(meta.poster),
          releaseInfo: meta.releaseInfo ?? null,
        })),
      };
    }),
  );

  return {
    ok: true,
    titleCount: built.data.metas.length,
    typeCounts: {
      movie: built.data.metas.filter((meta) => meta.type === "movie").length,
      series: built.data.metas.filter((meta) => meta.type === "series").length,
    },
    catalogs,
    unresolved: {
      count: built.unresolvedEntries.length,
      notCheckedYet: built.deferred,
      entries: built.unresolvedEntries
        .slice(0, PREVIEW_UNRESOLVED_LIMIT)
        .map(toUnresolvedEntry),
    },
    withoutDetails: built.withoutMetadata,
  };
}

/**
 * Preview a List before it is saved: read its Source list like a catalog
 * request would, but write no Catalog cache. Expected problems (private list,
 * missing Connection, Provider turned off) come back as a reason.
 */
export async function previewList(
  request: PreviewRequest,
): Promise<CatalogPreviewResponse> {
  if (PROVIDERS[request.provider].availability !== "available") {
    return { ok: false, reason: "coming_soon" };
  }
  if (!isProviderEnabled(request.provider)) {
    return { ok: false, reason: "disabled" };
  }
  try {
    return presentPreview(request, await readSource(request));
  } catch (error) {
    if (error instanceof SourceUnavailableError) {
      return { ok: false, reason: error.reason };
    }
    if (error instanceof ConnectionExpiredError) {
      return { ok: false, reason: "needs_connection" };
    }
    console.error(
      `Previewing ${request.provider} ${request.sourceRef} failed:`,
      error instanceof Error ? error.message : error,
    );
    return { ok: false, reason: "unavailable" };
  }
}
