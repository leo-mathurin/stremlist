import { CHART_BY_ID } from "@stremlist/shared/imdb-charts";
import {
  MAX_SOURCES_PER_LIST,
  allowedDisplayModes,
  isSortAllowed,
  listSources,
} from "@stremlist/shared/list-merge";
import { MAX_LISTS, createListRow, rowTitle } from "./list-form";
import type { ListFormRow } from "./list-form";
import { describeSource } from "./list-sources";

/**
 * How the configure page merges Lists and takes Source lists out of them
 * (ADR 0006). Each change returns the new rows, or a message for the user
 * when the change is not possible.
 */

/** The sort a merged List gets when its Source lists have no dates. */
const UNDATED_MERGE_SORT = "title-asc";

/**
 * The row after its Source lists changed: a display mode or a date sort
 * that the merge rules no longer allow falls back to one they allow, and
 * the row explains why next to the control.
 */
function withAllowedSettings(row: ListFormRow): ListFormRow {
  return {
    ...row,
    displayMode: allowedDisplayModes(row).includes(row.displayMode)
      ? row.displayMode
      : "split",
    sortOption: isSortAllowed(row, row.sortOption)
      ? row.sortOption
      : UNDATED_MERGE_SORT,
  };
}

/** The row without one of its Source lists; the next one moves up. */
function withoutSource(row: ListFormRow, index: number): ListFormRow {
  const [first, ...rest] = listSources(row).filter((_, i) => i !== index);
  return withAllowedSettings({
    ...row,
    provider: first.provider,
    sourceRef: first.sourceRef,
    mergedSources: rest,
    // The promoted Source list keeps its name.
    sourceLabel: first.label,
  });
}

/**
 * Merge the Source lists of another List into a List, after its own. The
 * other List goes away; the target keeps its title and settings.
 */
export function mergeRows(
  rows: ListFormRow[],
  targetLocalId: string,
  otherLocalId: string,
): ListFormRow[] | string {
  const target = rows.find((row) => row.localId === targetLocalId);
  const other = rows.find((row) => row.localId === otherLocalId);
  if (!target || !other || target === other) return rows;
  const added = listSources(other);
  if (listSources(target).length + added.length > MAX_SOURCES_PER_LIST) {
    return `A List can merge at most ${MAX_SOURCES_PER_LIST} Source lists.`;
  }
  return rows.flatMap((row) => {
    if (row === other) return [];
    if (row !== target) return [row];
    return [
      withAllowedSettings({
        ...row,
        // The other List's title names its first Source list here.
        mergedSources: [
          ...row.mergedSources,
          ...added.map((source, index) =>
            index === 0 ? { ...source, label: rowTitle(other) } : source,
          ),
        ],
      }),
    ];
  });
}

/** Remove one Source list of a merged List; the next one moves up. */
export function removeRowSource(
  rows: ListFormRow[],
  localId: string,
  index: number,
): ListFormRow[] {
  return rows.map((row) =>
    row.localId === localId && listSources(row).length > 1
      ? withoutSource(row, index)
      : row,
  );
}

/**
 * Take one Source list out of a merged List and give it its own List, just
 * below. Refused when the Account has no room for one more List.
 */
export function splitRowSource(
  rows: ListFormRow[],
  localId: string,
  index: number,
): ListFormRow[] | string {
  const at = rows.findIndex((row) => row.localId === localId);
  const sources = at >= 0 ? listSources(rows[at]) : [];
  const source = sources.at(index);
  if (!source || sources.length < 2) return rows;
  if (rows.length >= MAX_LISTS) {
    return `You can have at most ${MAX_LISTS} lists. Remove one to split this List.`;
  }
  const chart =
    source.provider === "imdb" ? CHART_BY_ID.get(source.sourceRef) : undefined;
  const split = createListRow({
    ...source,
    catalogTitle:
      source.label ??
      describeSource(source.provider, source.sourceRef).suggestedTitle,
    displayMode: chart?.defaultDisplayMode,
  });
  return [
    ...rows.slice(0, at),
    withoutSource(rows[at], index),
    split,
    ...rows.slice(at + 1),
  ];
}
