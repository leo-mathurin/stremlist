import { useCallback, useState } from "react";
import { CHART_BY_ID } from "@stremlist/shared/imdb-charts";
import {
  accountListsProblem,
  listMergeProblem,
} from "@stremlist/shared/list-merge";
import { createListRow, rowTitle } from "../lib/list-form";
import type { ListFormRow } from "../lib/list-form";
import { mergeRows, removeRowSource, splitRowSource } from "../lib/merged-rows";

/** The List rows of the configure page, their edits and what is wrong. */
export function useListEditor() {
  const [lists, setLists] = useState<ListFormRow[]>([]);

  const setListField = useCallback(
    <K extends keyof ListFormRow>(
      localId: string,
      key: K,
      value: ListFormRow[K],
    ) => {
      setLists((current) =>
        current.map((list) =>
          list.localId === localId ? { ...list, [key]: value } : list,
        ),
      );
    },
    [],
  );

  /**
   * Add a List. Returns an error message when it cannot be added, so the
   * caller can show it next to the control that asked.
   */
  const addList = (partial: Parameters<typeof createListRow>[0]) => {
    const problem = accountListsProblem([...lists, partial]);
    if (problem) {
      return problem.reason === "duplicate_source"
        ? "This list is already in your Stremlist."
        : problem.message;
    }
    setLists((rows) => [...rows, createListRow(partial)]);
    return null;
  };

  /** Add a built-in IMDb chart. Returns an error message, like `addList`. */
  const addChartList = (chartId: string): string | null => {
    const entry = CHART_BY_ID.get(chartId);
    if (!entry) return null;
    return addList({
      provider: "imdb",
      sourceRef: entry.id,
      catalogTitle: entry.label,
      displayMode: entry.defaultDisplayMode,
    });
  };

  const removeList = useCallback((localId: string) => {
    setLists((current) => current.filter((list) => list.localId !== localId));
  }, []);

  const mergeLists = useCallback((targetLocalId: string, otherId: string) => {
    setLists((rows) => mergeRows(rows, targetLocalId, otherId));
  }, []);

  const removeSource = useCallback((localId: string, index: number) => {
    setLists((rows) => removeRowSource(rows, localId, index));
  }, []);

  const splitSource = useCallback((localId: string, index: number) => {
    setLists((rows) => splitRowSource(rows, localId, index));
  }, []);

  const reorderLists = useCallback((initialIndex: number, index: number) => {
    setLists((items) => {
      const allDefaultTitles = items.every((list, i) => {
        const title = list.catalogTitle.trim();
        return title === "" || title === String(i + 1);
      });
      const reordered = [...items];
      const [removed] = reordered.splice(initialIndex, 1);
      reordered.splice(index, 0, removed);
      // Numbered default titles follow the position, so drop them and let
      // the backend number the Lists again.
      return allDefaultTitles
        ? reordered.map((list) => ({ ...list, catalogTitle: "" }))
        : reordered;
    });
  }, []);

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
    setListField,
    addList,
    addChartList,
    removeList,
    mergeLists,
    removeSource,
    splitSource,
    reorderLists,
    validationError,
  };
}
