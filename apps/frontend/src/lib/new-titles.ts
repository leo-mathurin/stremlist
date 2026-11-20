import {
  DEFAULT_NEW_TITLES_SETTINGS,
  NEW_TITLES_SORT_OPTIONS,
  defaultNewTitlesSettings,
} from "@stremlist/shared/manifest-catalogs";
import type { NewTitlesSettings } from "@stremlist/shared/stremio.types";
import { MAX_CATALOG_TITLE_LENGTH } from "./list-form";
import type { ListFormRow } from "./list-form";

/** The sortable ID of the "New titles" row. List rows use random hex IDs. */
export const NEW_TITLES_ROW_ID = "new-titles";

/** The title that the row and Stremio show when the user gave none. */
export const NEW_TITLES_FALLBACK_TITLE =
  DEFAULT_NEW_TITLES_SETTINGS.catalogTitle;

/** The "New titles" catalog as the configure page edits it (ADR 0007). */
export interface NewTitlesForm {
  enabled: boolean;
  settings: NewTitlesSettings;
}

export const NEW_TITLES_OFF: NewTitlesForm = {
  enabled: false,
  settings: DEFAULT_NEW_TITLES_SETTINGS,
};

/** A sort that "New titles" accepts: an unknown one falls back to the first. */
export function newTitlesSort(value: string) {
  return (
    NEW_TITLES_SORT_OPTIONS.find((option) => option.value === value)?.value ??
    NEW_TITLES_SORT_OPTIONS[0].value
  );
}

export function newTitlesTitle(settings: NewTitlesSettings) {
  return settings.catalogTitle.trim() || NEW_TITLES_FALLBACK_TITLE;
}

/** The catalog, as it was when "New titles" was added from Quick add. */
export function addedNewTitles() {
  return {
    enabled: true,
    settings: { ...DEFAULT_NEW_TITLES_SETTINGS, position: 0 },
  } satisfies NewTitlesForm;
}

/** The "New titles" catalog of a saved config answer. */
export function newTitlesFromAnswer(answer: {
  enabled: boolean;
  settings?: NewTitlesSettings;
}) {
  return {
    enabled: answer.enabled,
    settings: answer.settings ?? DEFAULT_NEW_TITLES_SETTINGS,
  } satisfies NewTitlesForm;
}

/** A draft that this page, or an older one, kept in session storage. */
export interface KeptDraft {
  lists: Pick<ListFormRow, "displayMode">[];
  newTitles?: unknown;
  newTitlesEnabled?: unknown;
}

/**
 * The "New titles" catalog of a draft kept by an older page, which had
 * only an on/off `newTitlesEnabled`.
 */
export function keptNewTitles(draft: KeptDraft) {
  if (isNewTitlesForm(draft.newTitles)) return draft.newTitles;
  return {
    enabled: draft.newTitlesEnabled === true,
    settings: defaultNewTitlesSettings(draft.lists),
  } satisfies NewTitlesForm;
}

function isNewTitlesForm(value: unknown): value is NewTitlesForm {
  return (
    typeof value === "object" &&
    value !== null &&
    "enabled" in value &&
    typeof value.enabled === "boolean" &&
    "settings" in value &&
    typeof value.settings === "object" &&
    value.settings !== null
  );
}

/** What a save sends: the settings only while the catalog is on. */
export function newTitlesPayload(form: NewTitlesForm) {
  return form.enabled
    ? {
        enabled: true,
        settings: {
          ...form.settings,
          sortOption: newTitlesSort(form.settings.sortOption),
          catalogTitle: form.settings.catalogTitle
            .trim()
            .slice(0, MAX_CATALOG_TITLE_LENGTH),
        },
      }
    : { enabled: false };
}

type CatalogRow =
  | { kind: "list"; id: string; list: ListFormRow; listIndex: number }
  | { kind: "new-titles"; id: typeof NEW_TITLES_ROW_ID };

function clampPosition(position: number, count: number) {
  if (!Number.isFinite(position)) return 0;
  return Math.min(Math.max(0, Math.trunc(position)), count);
}

/** The rows of "Your lists": the Lists, with "New titles" when it is on. */
export function catalogRows(lists: ListFormRow[], newTitles: NewTitlesForm) {
  const rows: CatalogRow[] = lists.map((list, listIndex) => ({
    kind: "list",
    id: list.localId,
    list,
    listIndex,
  }));
  if (newTitles.enabled) {
    rows.splice(clampPosition(newTitles.settings.position, lists.length), 0, {
      kind: "new-titles",
      id: NEW_TITLES_ROW_ID,
    });
  }
  return rows;
}

/**
 * The position of "New titles" after the Lists change from `before` to
 * `after`: it stays right after the List that came before it, wherever
 * that List is now. A List added at the top so lands above it unless it
 * was first.
 */
export function followListChange(
  position: number,
  before: ListFormRow[],
  after: ListFormRow[],
) {
  const at = clampPosition(position, before.length);
  if (at === 0) return 0;
  const above = new Set(before.slice(0, at).map((list) => list.localId));
  let last = -1;
  after.forEach((list, index) => {
    if (above.has(list.localId)) last = index;
  });
  return last + 1;
}

/**
 * Move the row at `from` to `to` (indexes in `catalogRows`). Returns the
 * Lists in their new order and the new position of "New titles".
 */
export function moveCatalogRow(
  lists: ListFormRow[],
  newTitles: NewTitlesForm,
  from: number,
  to: number,
) {
  const rows = catalogRows(lists, newTitles);
  const [moved] = rows.splice(from, 1);
  if (!moved) return { lists, position: newTitles.settings.position };
  rows.splice(to, 0, moved);
  const position = rows.findIndex((row) => row.kind === "new-titles");
  return {
    lists: rows.flatMap((row) => (row.kind === "list" ? [row.list] : [])),
    position: position < 0 ? newTitles.settings.position : position,
  };
}
