import type { CatalogPreset } from "./catalog-settings";
import type { ProviderId } from "./providers";
import type { SourceProblemReason } from "./source-problems";

/** One Title of a Catalog preview: only what a poster tile needs. */
export interface PreviewTitle {
  id: string;
  type: "movie" | "series";
  name: string;
  poster: string | null;
  releaseInfo: string | null;
}

/** One Catalog that a List adds to Stremio, with its first Titles. */
export interface CatalogPreviewRow {
  type: "movie" | "series";
  /** The extra Catalog of a preset, or null for the List's main Catalog. */
  preset: CatalogPreset | null;
  /** Titles in this Catalog, after the List's filters. */
  total: number;
  /** The first Titles, in the order that Stremio shows them. */
  titles: PreviewTitle[];
}

/** An entry of the Source list without an IMDb ID yet (CONTEXT.md). */
export interface PreviewUnresolvedEntry {
  title: string | null;
  year: number | null;
  type: "movie" | "series" | null;
  /** A page about the entry (its Provider, JustWatch or TMDB), when known. */
  url: string | null;
}

export interface CatalogPreview {
  ok: true;
  /** Titles of the Source list that Stremlist can show. */
  titleCount: number;
  /**
   * Titles of each type, before filters. A type that the List's display mode
   * hides is not in `catalogs`, but the page can say how many it hides.
   */
  typeCounts: { movie: number; series: number };
  catalogs: CatalogPreviewRow[];
  unresolved: {
    count: number;
    /** Unresolved entries that Stremlist did not check yet. */
    notCheckedYet: number;
    /** The first Unresolved entries, in Source list order. */
    entries: PreviewUnresolvedEntry[];
  };
  /** Titles with an IMDb ID but no details yet, so they are not shown. */
  withoutDetails: number;
  /**
   * Source lists of a merged List that could not be read, so their Titles
   * are not in the preview (Stremio leaves them out too). Absent when all
   * were read.
   */
  sourceProblems?: PreviewSourceProblem[];
}

/** A Source list of a merged List that the preview could not read. */
export interface PreviewSourceProblem {
  provider: ProviderId;
  sourceRef: string;
  reason: SourceProblemReason;
}

export interface CatalogPreviewProblem {
  ok: false;
  reason: SourceProblemReason;
  /** In a merged List, the Source list that has the problem. */
  source?: { provider: ProviderId; sourceRef: string };
}

export type CatalogPreviewResponse = CatalogPreview | CatalogPreviewProblem;
