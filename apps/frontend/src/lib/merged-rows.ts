import { imdbChartOf } from "@stremlist/shared/imdb-charts";
import {
  allowedDisplayModes,
  isSortAllowed,
  listSources,
} from "@stremlist/shared/list-merge";
import { createListRow, rowTitle } from "./list-form";
import type { ListFormRow } from "./list-form";
import { describeSource } from "./list-sources";

/**
 * How the configure page merges Lists and takes Source lists out of them
 * (ADR 0006). The page offers only the changes that the limits allow.
 */

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
      : "title-asc",
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
): ListFormRow[] {
  const other = rows.find((row) => row.localId === otherLocalId);
  if (!other) return rows;
  // The other List's title names its first Source list here.
  const [first, ...rest] = listSources(other);
  const added = [{ ...first, label: rowTitle(other) }, ...rest];
  return rows.flatMap((row) =>
    row === other
      ? []
      : row.localId === targetLocalId
        ? [
            withAllowedSettings({
              ...row,
              mergedSources: [...row.mergedSources, ...added],
            }),
          ]
        : [row],
  );
}

/** Remove one Source list of a merged List; the next one moves up. */
export function removeRowSource(
  rows: ListFormRow[],
  localId: string,
  index: number,
): ListFormRow[] {
  return rows.map((row) =>
    row.localId === localId ? withoutSource(row, index) : row,
  );
}

/** Take one Source list out of a merged List and give it its own List, just below. */
export function splitRowSource(
  rows: ListFormRow[],
  localId: string,
  index: number,
): ListFormRow[] {
  return rows.flatMap((row) => {
    if (row.localId !== localId) return [row];
    const source = listSources(row)[index];
    const chart = imdbChartOf(source);
    return [
      withoutSource(row, index),
      createListRow({
        ...source,
        catalogTitle:
          source.label ??
          describeSource(source.provider, source.sourceRef).suggestedTitle,
        displayMode: chart?.defaultDisplayMode,
      }),
    ];
  });
}
