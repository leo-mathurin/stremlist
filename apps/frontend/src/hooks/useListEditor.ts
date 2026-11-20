import { useCallback, useState } from "react";
import type { SetStateAction } from "react";
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
import {
  addedNewTitles,
  followListChange,
  moveCatalogRow,
  NEW_TITLES_OFF,
  NEW_TITLES_ROW_ID,
  newTitlesTitle,
} from "../lib/new-titles";
import type { NewTitlesForm } from "../lib/new-titles";

export type AddListProblem =
  | { kind: "duplicate"; localId: string }
  | { kind: "error"; message: string };

/** The row that the user added last, so the page can show it. */
export interface AddedRow {
  localId: string;
  title: string;
}

interface EditorRows {
  lists: ListFormRow[];
  newTitles: NewTitlesForm;
}

function renumberedLists(before: ListFormRow[], after: ListFormRow[]) {
  if (before.every((list, index) => list === after[index])) return before;
  const allDefaultTitles = before.every((list, i) => {
    const title = list.catalogTitle.trim();
    return title === "" || title === String(i + 1);
  });
  return allDefaultTitles
    ? after.map((list) => ({ ...list, catalogTitle: "" }))
    : after;
}

/**
 * The rows of "Your lists" on the configure page: the Lists, and the
 * built-in "New titles" catalog among them. Their edits and what is wrong.
 */
export function useListEditor() {
  const [rows, setRows] = useState<EditorRows>({
    lists: [],
    newTitles: NEW_TITLES_OFF,
  });
  const { lists, newTitles } = rows;
  const [lastAdded, setLastAdded] = useState<AddedRow | null>(null);

  const setLists = useCallback(
    (update: SetStateAction<ListFormRow[]>) =>
      setRows((current) => {
        const next =
          typeof update === "function" ? update(current.lists) : update;
        if (next === current.lists) return current;
        return {
          lists: next,
          newTitles: {
            ...current.newTitles,
            settings: {
              ...current.newTitles.settings,
              position: followListChange(
                current.newTitles.settings.position,
                current.lists,
                next,
              ),
            },
          },
        };
      }),
    [],
  );

  const resetRows = useCallback(
    (nextLists: ListFormRow[], nextNewTitles: NewTitlesForm) =>
      setRows({ lists: nextLists, newTitles: nextNewTitles }),
    [],
  );

  const setNewTitlesField = <K extends keyof NewTitlesForm["settings"]>(
    key: K,
    value: NewTitlesForm["settings"][K],
  ) =>
    setRows((current) => ({
      ...current,
      newTitles: {
        ...current.newTitles,
        settings: { ...current.newTitles.settings, [key]: value },
      },
    }));

  const addNewTitles = () => {
    const added = addedNewTitles();
    setRows((current) => ({ ...current, newTitles: added }));
    setLastAdded({
      localId: NEW_TITLES_ROW_ID,
      title: newTitlesTitle(added.settings),
    });
  };

  const removeNewTitles = () =>
    setRows((current) => ({
      ...current,
      newTitles: { ...current.newTitles, enabled: false },
    }));

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
    setLists((current) => [row, ...current]);
    setLastAdded({ localId: row.localId, title: rowTitle(row) });
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

  const reorderRows = (initialIndex: number, index: number) =>
    setRows((current) => {
      const moved = moveCatalogRow(
        current.lists,
        current.newTitles,
        initialIndex,
        index,
      );
      return {
        lists: renumberedLists(current.lists, moved.lists),
        newTitles: {
          ...current.newTitles,
          settings: { ...current.newTitles.settings, position: moved.position },
        },
      };
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
    resetRows,
    newTitles,
    setNewTitlesField,
    addNewTitles,
    removeNewTitles,
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
    reorderRows,
    validationError,
  };
}
