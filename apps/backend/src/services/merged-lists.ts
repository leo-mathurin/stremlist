import type { ListSource, MergeableList } from "@stremlist/shared/list-merge";
import {
  isMergedList,
  listSources,
  sourceKey,
  sourcesWithoutDates,
} from "@stremlist/shared/list-merge";
import type { ProviderId } from "@stremlist/shared/providers";
import { PROVIDERS } from "@stremlist/shared/providers";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { createHash } from "node:crypto";
import type { SourceMeta } from "./list-cache";

/**
 * Where each Source list of a List keeps its cached Catalog (ADR 0006). A
 * List with one Source list keeps the List ID, as before merged Lists, so
 * existing caches stay valid. In a merged List each Source list has its own
 * key, derived from the Source list, so reordering or removing one does not
 * mix up the caches of the others.
 */
export function sourceCaches(
  list: MergeableList & { id: string },
): { source: ListSource; cacheKey: string }[] {
  const sources = listSources(list);
  if (sources.length === 1) {
    return [{ source: sources[0], cacheKey: list.id }];
  }
  return sources.map((source) => ({
    source,
    cacheKey: `${list.id}/sources/${createHash("sha256")
      .update(sourceKey(source))
      .digest("hex")
      .slice(0, 16)}`,
  }));
}

/**
 * Cache keys that a save stopped using: removed Lists, removed Source lists,
 * and the List ID key when its Source list changed or the List became merged.
 */
export function unusedSourceCaches(
  before: (MergeableList & { id: string })[],
  after: (MergeableList & { id: string })[],
): string[] {
  const kept = new Set(
    after
      .flatMap(sourceCaches)
      .map(({ source, cacheKey }) => `${cacheKey}|${sourceKey(source)}`),
  );
  return before
    .flatMap(sourceCaches)
    .filter(
      ({ source, cacheKey }) => !kept.has(`${cacheKey}|${sourceKey(source)}`),
    )
    .map(({ cacheKey }) => cacheKey);
}

/** The "More on {Provider}: {url}" line at the end of a description. */
const LINK_BACK = /(?:^|\n\n)(More on [^\n:]+: \S+)$/u;

/**
 * Add "More on {Provider}: {url}" at the end of the description when the
 * entry has a page on its Provider. Idempotent: metadata reused from the
 * previous cache already carries it.
 */
export function withLinkBack(
  meta: StremioMeta,
  provider: ProviderId,
  sourceUrl: string | undefined,
): StremioMeta {
  if (!sourceUrl) return meta;
  const base = meta.description.replace(LINK_BACK, "");
  const line = `More on ${PROVIDERS[provider].label}: ${sourceUrl}`;
  return { ...meta, description: base ? `${base}\n\n${line}` : line };
}

/**
 * Keep the "More on {Provider}" line of a duplicate that is dropped: Simkl's
 * terms ask for a link back on every item that comes from Simkl.
 */
function withLinkBackOf(kept: SourceMeta, dropped: SourceMeta): SourceMeta {
  const line = LINK_BACK.exec(dropped.description)?.[1];
  if (!line || kept.description.includes(line)) return kept;
  return {
    ...kept,
    description: kept.description ? `${kept.description}\n\n${line}` : line,
  };
}

function addedTime(meta: SourceMeta): number {
  const time = meta.addedAt ? Date.parse(meta.addedAt) : Number.NaN;
  // Like the Providers' own orders: entries without a date come first.
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

/**
 * The canonical Catalog of a merged List: every Title once, identified by
 * its IMDb ID. With dates, the Source lists are sorted together by when each
 * Title was added (oldest first) and a Title keeps its first date; without,
 * they follow each other in the List's order.
 */
export function mergeSourceCatalogs(
  catalogs: SourceMeta[][],
  byAddedDate: boolean,
): SourceMeta[] {
  const entries = catalogs.flat();
  const ordered = byAddedDate
    ? entries
        .map((meta, index) => ({ meta, index, at: addedTime(meta) }))
        .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at - b.at))
        .map(({ meta }) => meta)
    : entries;

  const byId = new Map<string, number>();
  const merged: SourceMeta[] = [];
  for (const meta of ordered) {
    const index = byId.get(meta.id);
    if (index === undefined) {
      byId.set(meta.id, merged.length);
      merged.push(meta);
    } else {
      merged[index] = withLinkBackOf(merged[index], meta);
    }
  }
  return merged;
}

/**
 * The canonical Catalog of a List from the Catalogs of the Source lists it
 * could read, in the List's order. A List with one Source list keeps its
 * Catalog as it is, in its Provider's order and without deduplication by
 * bare IMDb ID (a movie and a series may share one). A merged List sorts by
 * date added only when every Source list gives dates (ADR 0006).
 */
export function mergeListCatalogs(
  list: MergeableList,
  catalogs: SourceMeta[][],
): SourceMeta[] {
  return isMergedList(list)
    ? mergeSourceCatalogs(catalogs, sourcesWithoutDates(list).length === 0)
    : catalogs[0];
}

/** The meta as Stremio gets it: the date added stays in the cache. */
export function toStremioMeta(meta: SourceMeta): StremioMeta {
  if (meta.addedAt === undefined) return meta;
  const copy = { ...meta };
  delete copy.addedAt;
  return copy;
}
