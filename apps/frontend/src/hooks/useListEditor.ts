import { useState } from "react";
import { CHART_BY_ID } from "@stremlist/shared/imdb-charts";
import {
  accountListsProblem,
  listSources,
  listMergeProblem,
  sourceKey,
} from "@stremlist/shared/list-merge";
import { createListRow, rowTitle } from "../lib/list-form";
import type { ListFormRow } from "../lib/list-form";
import { mergeRows, removeRowSource, splitRowSource } from "../lib/merged-rows";

export type AddListProblem =
  | { kind: "duplicate"; localId: string }
  | { kind: "error"; message: string };

/** The List rows of the configure page, their edits and what is wrong. */
export function useListEditor() {
  const [lists, setLists] = useState<ListFormRow[]>([]);
  const [lastAdded, setLastAdded] = useState<ListFormRow | null>(null);

  const setListField = <K extends keyof ListFormRow>(
    localId: string,
    key: K,
    value: ListFormRow[K],
  ) =>
    setLists((current) =>
      current.map((list) =>
        list.localId === localId ? { ...list, [key]: value } : list,
      ),
    );

  const addList = (partial: Parameters<typeof createListRow>[0]) => {
    const existing = lists.find((list) =>
      listSources(list).some(
        (source) => sourceKey(source) === sourceKey(partial),
      ),
    );
    if (existing)
      return {
        kind: "duplicate",
        localId: existing.localId,
      } satisfies AddListProblem;
    const problem = accountListsProblem([partial, ...lists]);
    if (problem)
      return {
        kind: "error",
        message: problem.message,
      } satisfies AddListProblem;
    const row = createListRow(partial);
    setLists((rows) => [row, ...rows]);
    setLastAdded(row);
    return null;
  };

  const addChartList = (chartId: string) => {
    const entry = CHART_BY_ID.get(chartId);
    if (!entry) return null;
    return addList({
      provider: "imdb",
      sourceRef: entry.id,
      catalogTitle: entry.label,
      displayMode: entry.defaultDisplayMode,
    });
  };

  const reorderLists = (initialIndex: number, index: number) =>
    setLists((items) => {
      const allDefaultTitles = items.every((list, i) => {
        const title = list.catalogTitle.trim();
        return title === "" || title === String(i + 1);
      });
      const reordered = [...items];
      const [removed] = reordered.splice(initialIndex, 1);
      reordered.splice(index, 0, removed);
      return allDefaultTitles
        ? reordered.map((list) => ({ ...list, catalogTitle: "" }))
        : reordered;
    });

  const validationError = (() => {
    const problem = accountListsProblem(lists);
    if (problem) return problem.message;
    for (const list of lists) {
      const problem = listMergeProblem(list);
      if (problem) return `${rowTitle(list)}: ${problem}`;
    }
    return null;
  })();

  return {
    lists,
    setLists,
    lastAdded,
    setListField,
    addList,
    addChartList,
    removeList: (localId: string) =>
      setLists((current) => current.filter((list) => list.localId !== localId)),
    mergeLists: (targetLocalId: string, otherId: string) =>
      setLists((rows) => mergeRows(rows, targetLocalId, otherId)),
    removeSource: (localId: string, index: number) =>
      setLists((rows) => removeRowSource(rows, localId, index)),
    splitSource: (localId: string, index: number) =>
      setLists((rows) => splitRowSource(rows, localId, index)),
    reorderLists,
    validationError,
  };
}
