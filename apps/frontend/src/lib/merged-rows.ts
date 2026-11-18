import { imdbChartOf } from "@stremlist/shared/imdb-charts";
import {
  allowedDisplayModes,
  isSortAllowed,
  listSources,
} from "@stremlist/shared/list-merge";
import { createListRow, rowTitle } from "./list-form";
import type { ListFormRow } from "./list-form";
import { describeSource } from "./list-sources";

function withAllowedSettings(row: ListFormRow) {
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

function withoutSource(row: ListFormRow, index: number) {
  const [first, ...rest] = listSources(row).filter((_, i) => i !== index);
  return withAllowedSettings({
    ...row,
    provider: first.provider,
    sourceRef: first.sourceRef,
    mergedSources: rest,
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
) {
  const other = rows.find((row) => row.localId === otherLocalId);
  if (!other) return rows;
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
) {
  return rows.map((row) =>
    row.localId === localId ? withoutSource(row, index) : row,
  );
}

/** Take one Source list out of a merged List and give it its own List, just below. */
export function splitRowSource(
  rows: ListFormRow[],
  localId: string,
  index: number,
) {
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
