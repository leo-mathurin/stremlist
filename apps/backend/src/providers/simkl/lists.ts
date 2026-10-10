import { HttpError } from "../http";
import { readPages } from "../paging";
import type {
  ConnectionAccess,
  PagedRead,
  SourceEntry,
  SourceSnapshot,
} from "../types";
import { connectionToken, SourceUnavailableError } from "../types";
import { simklRequest } from "./api";
import { toEntry } from "./entries";
import type { RawIds, SimklKind, SimklTitle } from "./library";
import { parseIds, syncLibrary, toInt } from "./library";
import { listKey, readState, STATE_VERSION, writeState } from "./state";

/** Auto lists are rebuilt daily without moving /sync/activities. */
const AUTO_LIST_MAX_AGE_MS = 24 * 60 * 60_000;
const LIST_PAGE_LIMIT = 500;
// Simkl refuses page * limit above 10000.
const LIST_MAX_PAGES = 20;

interface RawListItem {
  title?: string;
  year?: number | null;
  type?: string;
  anime_type?: string | null;
  ids?: RawIds;
}

interface RawListPage {
  error?: string;
  name?: string;
  type?: string;
  media_type?: string;
  items?: RawListItem[];
  pagination?: { total_pages?: number };
}

interface ListSnapshot {
  version: number;
  username: string | null;
  /** custom_lists.lists.all from /sync/activities when the list was read. */
  gate: string;
  listType?: string;
  premiumOnly?: boolean;
  fetchedAt: number;
  entries: SourceEntry[];
  /** False when LIST_MAX_PAGES cut the list short. */
  complete: boolean;
}

function premiumOnlyError(): SourceUnavailableError {
  return new SourceUnavailableError(
    "premium_only",
    "Simkl custom lists need a Simkl PRO or VIP account",
  );
}

/** One page of a custom list (beta, PRO and VIP only). */
export async function readListPage(
  token: string,
  listId: string,
  page: number,
  limit: number,
): Promise<RawListPage> {
  let data: RawListPage;
  try {
    data = await simklRequest<RawListPage>(`/lists/${listId}`, {
      token,
      params: { limit: String(limit), page: String(page) },
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) {
      throw new SourceUnavailableError(
        "private",
        `Simkl list ${listId} is private`,
      );
    }
    if (error instanceof HttpError && error.status === 404) {
      throw new SourceUnavailableError(
        "not_found",
        `Simkl list ${listId} not found`,
      );
    }
    throw error;
  }
  // A free account gets HTTP 200 with an error body instead of the list.
  if (data.error === "premium_only") throw premiumOnlyError();
  if (data.error) {
    throw new SourceUnavailableError(
      "unavailable",
      `Simkl list ${listId}: ${data.error}`,
    );
  }
  if (!Array.isArray(data.items)) {
    throw new SourceUnavailableError(
      "unavailable",
      `Simkl list ${listId} has no items`,
    );
  }
  return data;
}

function listItemKind(item: RawListItem): SimklKind {
  if (item.type === "anime") return "anime";
  return item.type === "movie" || item.anime_type === "movie"
    ? "movies"
    : "shows";
}

function parseListItem(item: RawListItem): SimklTitle | null {
  const { simkl, ...ids } = parseIds(item.ids ?? {});
  if (!simkl) return null;
  return {
    simkl,
    kind: listItemKind(item),
    ...ids,
    title: item.title,
    year: toInt(item.year),
    animeType: item.anime_type ?? undefined,
  };
}

/** A custom list in the owner's order, re-read only when activities say so. */
export async function fetchCustomList(
  connection: ConnectionAccess,
  listId: string,
): Promise<SourceSnapshot> {
  const library = await syncLibrary(connection);
  const gate = library.activities.custom_lists?.lists?.all ?? null;
  const key = listKey(connection.accountId, listId);
  const previous = await readState<ListSnapshot>(key);
  if (
    gate &&
    previous?.version === STATE_VERSION &&
    previous.username === connection.username &&
    previous.gate === gate &&
    ((previous.listType !== "auto" && !previous.premiumOnly) ||
      Date.now() - previous.fetchedAt < AUTO_LIST_MAX_AGE_MS)
  ) {
    if (previous.premiumOnly) throw premiumOnlyError();
    return { entries: previous.entries, complete: previous.complete };
  }

  const token = await connectionToken(connection);
  const save = (
    snapshot: Omit<ListSnapshot, "version" | "username" | "gate" | "fetchedAt">,
  ) =>
    gate
      ? writeState(key, {
          version: STATE_VERSION,
          username: connection.username,
          gate,
          fetchedAt: Date.now(),
          ...snapshot,
        } satisfies ListSnapshot)
      : Promise.resolve();

  let listType: string | undefined;
  let read: PagedRead<SourceEntry>;
  try {
    read = await readPages({
      maxPages: LIST_MAX_PAGES,
      first: 1,
      async page(page) {
        const data = await readListPage(token, listId, page, LIST_PAGE_LIMIT);
        listType = data.type;
        return {
          items: (data.items ?? []).flatMap((item) => {
            const title = parseListItem(item);
            return title ? [toEntry(title)] : [];
          }),
          next: page >= (data.pagination?.total_pages ?? 1) ? null : page + 1,
        };
      },
    });
  } catch (error) {
    if (
      error instanceof SourceUnavailableError &&
      error.reason === "premium_only"
    ) {
      await save({ premiumOnly: true, entries: [], complete: false });
    }
    throw error;
  }
  const { items: entries, complete } = read;
  await save({ listType, entries, complete });
  return { entries, complete };
}
