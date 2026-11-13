import { z } from "zod";
import { sourceErrorFromHttp } from "../http";
import { readPages } from "../paging";
import type {
  ConnectionAccess,
  PagedRead,
  SourceEntry,
  SourceSnapshot,
} from "../types";
import { SourceUnavailableError } from "../types";
import { simklRequest } from "./api";
import { toEntry } from "./entries";
import type { SimklKind, SimklTitle } from "./library";
import { parseIds, rawIdsSchema, syncLibrary, toInt } from "./library";
import { listKey, readState, STATE_VERSION, writeState } from "./state";

/** Auto lists are rebuilt daily without moving /sync/activities. */
const AUTO_LIST_MAX_AGE_MS = 24 * 60 * 60_000;
const LIST_PAGE_LIMIT = 500;
// Simkl refuses page * limit above 10000.
const LIST_MAX_PAGES = 20;

const rawListItemSchema = z.object({
  title: z.string().nullish(),
  year: z.number().nullish(),
  type: z.string().nullish(),
  anime_type: z.string().nullish(),
  ids: rawIdsSchema.nullish(),
});
type RawListItem = z.infer<typeof rawListItemSchema>;

const rawListPageSchema = z.object({
  error: z.string().nullish(),
  name: z.string().nullish(),
  type: z.string().nullish(),
  media_type: z.string().nullish(),
  items: z.array(rawListItemSchema).nullish(),
  pagination: z.object({ total_pages: z.number().nullish() }).nullish(),
});
type RawListPage = z.infer<typeof rawListPageSchema>;

/** The entries that `toEntry` builds. */
const listEntrySchema = z.object({
  imdbId: z.string().optional(),
  externalIds: z
    .object({
      simkl: z.number().optional(),
      tmdb: z
        .object({ id: z.number(), type: z.enum(["movie", "series"]) })
        .optional(),
    })
    .optional(),
  type: z.enum(["movie", "series"]).optional(),
  title: z.string().optional(),
  year: z.number().optional(),
  sourceUrl: z.string().optional(),
  addedAt: z.string().optional(),
});

const listSnapshotSchema = z.object({
  version: z.number(),
  /** The authorization that read the list (`ConnectionAccess`). */
  authorization: z.string(),
  /** custom_lists.lists.all from /sync/activities when the list was read. */
  gate: z.string(),
  listType: z.string().optional(),
  premiumOnly: z.boolean().optional(),
  fetchedAt: z.number(),
  entries: z.array(listEntrySchema),
  /** False when LIST_MAX_PAGES cut the list short. */
  complete: z.boolean(),
});
type ListSnapshot = z.infer<typeof listSnapshotSchema>;

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
    data = await simklRequest(`/lists/${listId}`, rawListPageSchema, {
      token,
      params: { limit: String(limit), page: String(page) },
    });
  } catch (error) {
    throw sourceErrorFromHttp(
      error,
      { 403: "private", 404: "not_found" },
      (reason) =>
        reason === "private"
          ? `Simkl list ${listId} is private`
          : `Simkl list ${listId} not found`,
    );
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
    title: item.title ?? undefined,
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
  const previous = await readState(key, listSnapshotSchema);
  if (
    gate &&
    previous?.version === STATE_VERSION &&
    previous.authorization === connection.authorization &&
    previous.gate === gate &&
    ((previous.listType !== "auto" && !previous.premiumOnly) ||
      Date.now() - previous.fetchedAt < AUTO_LIST_MAX_AGE_MS)
  ) {
    if (previous.premiumOnly) throw premiumOnlyError();
    return { entries: previous.entries, complete: previous.complete };
  }

  const token = await connection.getAccessToken();
  const save = (
    snapshot: Omit<
      ListSnapshot,
      "version" | "authorization" | "gate" | "fetchedAt"
    >,
  ) =>
    gate
      ? writeState(key, {
          version: STATE_VERSION,
          authorization: connection.authorization,
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
        listType = data.type ?? undefined;
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
