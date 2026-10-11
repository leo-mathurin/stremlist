import type { TitleType } from "@stremlist/shared/constants";
import type { ListSource } from "@stremlist/shared/list-merge";
import { listSources, sourceKey } from "@stremlist/shared/list-merge";
import type { ProviderId } from "@stremlist/shared/providers";
import {
  PROVIDERS,
  sourceRequiresConnection,
} from "@stremlist/shared/providers";
import { storedSourceNoun } from "@stremlist/shared/source-problems";
import type {
  ConfigList,
  NewTitlesSummary,
  StremioMeta,
} from "@stremlist/shared/stremio.types";
import type { ProviderAdapter, SourceEntry } from "../providers/types";
import type { AccountAccess } from "./accounts";
import { getVisibleLists, visibleLists } from "./accounts";
import { listConnections } from "./connections";
import { buildPosterUrl } from "./imdb-scraper";
import { getCachedList } from "./list-cache";
import type { SourceMeta } from "./list-cache";
import { sourceCaches, toStremioMeta } from "./merged-lists";
import type { HistoryConnection, SourceHistory } from "./title-history";
import {
  historyApplies,
  listNewTitles,
  readHistory,
  recordHistory,
} from "./title-history";

/** One Title of the "New titles" catalog, with its first detection. */
interface Detection {
  imdbId: string;
  detectedAt: Date;
  /** The List whose Source list had the earliest detection. */
  list: ConfigList;
  /** That Source list: one of the List's own (several in a merged List). */
  source: ListSource;
}

/**
 * Most Titles read for one catalog request, newest first. Older detections
 * drop out of the catalog, which only shows what is new.
 */
const MAX_DETECTIONS = 1000;

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * Every Source list of the Lists, with its List. A Source list is in one List
 * of an Account at most, so the key finds the List back.
 */
function sourcesOf(
  lists: ConfigList[],
): Map<string, { list: ConfigList; source: ListSource }> {
  return new Map(
    lists.flatMap((list) =>
      listSources(list).map(
        (source) => [sourceKey(source), { list, source }] as const,
      ),
    ),
  );
}

function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The stable identity of an entry in its Source list, resolved or not: the
 * Provider's own ID (the resolver key), else the IMDb ID, else a normalized
 * title and year for Providers that give no ID for the entry. Null when the
 * entry has none of these: it cannot be followed between synchronizations.
 */
export function entryKey(
  adapter: ProviderAdapter,
  entry: SourceEntry,
): string | null {
  const key = adapter.resolutionKey?.(entry);
  if (key) return `${key.namespace}:${key.externalId}`;
  if (entry.imdbId) return `imdb:${entry.imdbId}`;
  const title = entry.title ? normalizeTitle(entry.title) : "";
  return title ? `title:${title}:${entry.year ?? ""}` : null;
}

/**
 * Record one complete, successful synchronization of a Source list: no
 * Provider error and every page read. Unresolved entries (without an IMDb ID
 * in `imdbIds`) count by their entry key. Callers must not call this for a
 * failed or cut-short read: a missing entry would look like a removal. Never
 * throws, because a catalog must not fail on its history.
 */
export async function recordSynchronization(
  source: {
    accountId: string;
    listId: string;
    provider: ProviderId;
    sourceRef: string;
  },
  adapter: ProviderAdapter,
  entries: SourceEntry[],
  imdbIds: ReadonlyMap<SourceEntry, string>,
  read: {
    /** When the read started: a slower, older read never wins. */
    startedAt: Date;
    /** The Connection user the read went through, if any. */
    connectionUser: string | null;
  },
): Promise<void> {
  const keyed = entries.flatMap((entry) => {
    const key = entryKey(adapter, entry);
    return key ? [{ key, imdbId: imdbIds.get(entry) ?? null }] : [];
  });
  try {
    // History of a Source list that only a Connection can read belongs to
    // that Connection's Provider user: nothing is written when that
    // Connection is gone or replaced (a disconnect during the read).
    let connection: HistoryConnection | null = null;
    if (sourceRequiresConnection(source.provider, source.sourceRef)) {
      const current = (await listConnections(source.accountId)).find(
        (candidate) => candidate.provider === source.provider,
      );
      if (current?.username !== read.connectionUser) return;
      connection = { user: current.username, connectedAt: current.connectedAt };
    }
    const added = await recordHistory(
      source.accountId,
      source,
      keyed,
      read.startedAt,
      connection,
    );
    if (added) {
      console.log(`List ${source.listId}: ${added} new entries`);
    }
  } catch (error) {
    console.error(
      `Failed to record the synchronization of list ${source.listId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * The histories of these Source lists that still apply (see
 * `historyApplies`), by `sourceKey`. A Source list without one has no
 * Baseline yet.
 */
async function loadHistories(
  accountId: string,
  sources: ListSource[],
): Promise<Map<string, SourceHistory>> {
  const needsConnection = sources.some((source) =>
    sourceRequiresConnection(source.provider, source.sourceRef),
  );
  const connections = new Map<ProviderId, HistoryConnection>(
    needsConnection
      ? (await listConnections(accountId)).map((connection) => [
          connection.provider,
          { user: connection.username, connectedAt: connection.connectedAt },
        ])
      : [],
  );
  const histories = await Promise.all(
    sources.map(async (source) => {
      const history = await readHistory(accountId, source);
      return history &&
        historyApplies(
          history,
          source,
          connections.get(source.provider) ?? null,
        )
        ? ([sourceKey(source), history] as const)
        : null;
    }),
  );
  return new Map(histories.filter((entry) => entry !== null));
}

/**
 * Detected Titles that the Lists still contain, newest first, one per Title:
 * a Title that several Source lists have (in one merged List or in several
 * Lists) keeps its earliest detection. The rules live in `listNewTitles`.
 */
function toDetections(
  lists: ConfigList[],
  histories: Map<string, SourceHistory>,
): Detection[] {
  const sources = sourcesOf(lists);
  const titles = listNewTitles(
    [...sources.values()].flatMap(({ source }) => {
      const history = histories.get(sourceKey(source));
      return history ? [{ source, history }] : [];
    }),
    MAX_DETECTIONS,
  );
  return titles.flatMap((title) => {
    const found = sources.get(sourceKey(title.source));
    return found
      ? [
          {
            imdbId: title.imdbId,
            detectedAt: new Date(title.detectedAt),
            ...found,
          },
        ]
      : [];
  });
}

async function loadDetections(
  accountId: string,
  lists: ConfigList[],
): Promise<Detection[]> {
  const sources = [...sourcesOf(lists).values()].map(({ source }) => source);
  if (sources.length === 0) return [];
  return toDetections(lists, await loadHistories(accountId, sources));
}

/** The List's name as the user sees it, for the detection line. */
function listName({ list, source }: Detection): string {
  const title = list.catalogTitle.trim();
  // Default titles are positions ("1", "2"), which say nothing on their own:
  // name the Source list that detected the Title instead.
  if (title && !/^\d+$/u.test(title)) return title;
  return `your ${PROVIDERS[source.provider].label} ${storedSourceNoun(source.provider, source.sourceRef)}`;
}

function withDetectionLine(
  meta: StremioMeta,
  detection: Detection,
): StremioMeta {
  const line = `Detected by Stremlist on ${DATE_FORMAT.format(detection.detectedAt)} in ${listName(detection)}.`;
  return {
    ...meta,
    description: meta.description ? `${line}\n\n${meta.description}` : line,
  };
}

/**
 * The "New titles" catalog of an Account: Titles detected in its Lists,
 * newest detection first, without duplicates. Reads only the cached Catalogs
 * of the Source lists for metadata, never a Provider, like the meta route: a
 * Title whose Source list has no cached Catalog yet waits for the next
 * request.
 */
export async function getNewTitlesCatalog(
  access: AccountAccess,
  type: TitleType,
): Promise<StremioMeta[]> {
  const lists = await getVisibleLists(access);
  const detections = await loadDetections(access.account.id, lists);
  if (detections.length === 0) return [];

  const cached = await Promise.all(
    lists.flatMap(sourceCaches).map(async ({ source, cacheKey }) => {
      const catalog = await getCachedList(cacheKey, source);
      return [
        sourceKey(source),
        new Map<string, SourceMeta>(
          catalog?.data.metas.map((meta) => [meta.id, meta]) ?? [],
        ),
      ] as const;
    }),
  );
  const metasBySource = new Map(cached);

  return detections.flatMap((detection) => {
    // Prefer the Source list that detected the Title: its metadata carries
    // the link back to that Provider.
    const meta =
      metasBySource.get(sourceKey(detection.source))?.get(detection.imdbId) ??
      [...metasBySource.values()]
        .map((metas) => metas.get(detection.imdbId))
        .find((found) => !!found);
    if (meta?.type !== type) return [];
    return [
      {
        ...withDetectionLine(toStremioMeta(meta), detection),
        poster: buildPosterUrl(meta.id, meta.poster, access.account.rpdbApiKey),
      },
    ];
  });
}

/**
 * What the configure page says about the "New titles" catalog. Null when the
 * history cannot be read: the page then shows only the setting.
 */
export async function getNewTitlesSummary(
  access: AccountAccess,
  allLists: ConfigList[],
): Promise<NewTitlesSummary | null> {
  const lists = visibleLists(access, allLists);
  if (lists.length === 0) {
    return { detected: 0, latestDetectedAt: null, waitingLists: 0 };
  }
  try {
    const histories = await loadHistories(
      access.account.id,
      [...sourcesOf(lists).values()].map(({ source }) => source),
    );
    const detections = toDetections(lists, histories);
    return {
      detected: detections.length,
      latestDetectedAt: detections[0]?.detectedAt.toISOString() ?? null,
      // A merged List waits while one of its Source lists has no Baseline.
      waitingLists: lists.filter((list) =>
        listSources(list).some((source) => !histories.has(sourceKey(source))),
      ).length,
    };
  } catch (error) {
    console.error(
      "Failed to read the detection history:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
