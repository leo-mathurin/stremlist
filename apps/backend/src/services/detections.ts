import type { ListSource } from "@stremlist/shared/list-merge";
import { listSources, sourceKey } from "@stremlist/shared/list-merge";
import type { ProviderId, SourceId } from "@stremlist/shared/providers";
import {
  PROVIDERS,
  sourceRequiresConnection,
} from "@stremlist/shared/providers";
import { storedSourceNoun } from "@stremlist/shared/source-problems";
import type { ListCatalog } from "@stremlist/shared/manifest-catalogs";
import type {
  ConfigList,
  NewTitlesSettings,
  StremioMeta,
} from "@stremlist/shared/stremio.types";
import type { ProviderAdapter, SourceEntry } from "../providers/types";
import type { DigitalRelease } from "../titles/digital-release";
import type { AccountAccess } from "./accounts";
import { getVisibleLists, visibleLists } from "./accounts";
import { filterCatalog, resolveCatalogSelection } from "./catalog-filters";
import { sortCatalog } from "./catalog-sort";
import { listConnections } from "./connections";
import { getCachedList } from "./list-cache";
import type { SourceMeta } from "./list-cache";
import { sourceCaches, toFilterableMeta } from "./merged-lists";
import type { HistoryConnection, SourceHistory } from "./title-history";
import {
  historyApplies,
  listNewTitles,
  readHistory,
  recordHistory,
} from "./title-history";

interface Detection {
  imdbId: string;
  detectedAt: Date;
  list: ConfigList;
  source: ListSource;
}

const MAX_DETECTIONS = 1000;

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function sourcesOf(lists: ConfigList[]) {
  return new Map(
    lists.flatMap((list) =>
      listSources(list).map(
        (source) => [sourceKey(source), { list, source }] as const,
      ),
    ),
  );
}

function normalizeTitle(title: string) {
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
export function entryKey(adapter: ProviderAdapter, entry: SourceEntry) {
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
) {
  const keyed = entries.flatMap((entry) => {
    const key = entryKey(adapter, entry);
    return key ? [{ key, imdbId: imdbIds.get(entry) ?? null }] : [];
  });
  try {
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

interface LoadedHistories {
  histories: Map<string, SourceHistory>;
  unreadable: number;
}

function logReadError(what: string, error: unknown) {
  console.error(
    `Failed to read ${what}:`,
    error instanceof Error ? error.message : error,
  );
}

async function loadHistories(accountId: string, sources: ListSource[]) {
  const needsConnection = sources.some((source) =>
    sourceRequiresConnection(source.provider, source.sourceRef),
  );
  let connections: Map<ProviderId, HistoryConnection> | null = new Map();
  if (needsConnection) {
    try {
      connections = new Map(
        (await listConnections(accountId)).map((connection) => [
          connection.provider,
          { user: connection.username, connectedAt: connection.connectedAt },
        ]),
      );
    } catch (error) {
      logReadError(`the Connections of account ${accountId}`, error);
      connections = null;
    }
  }
  const histories = new Map<string, SourceHistory>();
  let unreadable = 0;
  await Promise.all(
    sources.map(async (source) => {
      if (
        !connections &&
        sourceRequiresConnection(source.provider, source.sourceRef)
      ) {
        unreadable += 1;
        return;
      }
      let history: SourceHistory | null;
      try {
        history = await readHistory(accountId, source);
      } catch (error) {
        logReadError(`the detection history of ${sourceKey(source)}`, error);
        unreadable += 1;
        return;
      }
      if (
        history &&
        historyApplies(
          history,
          source,
          connections?.get(source.provider) ?? null,
        )
      ) {
        histories.set(sourceKey(source), history);
      }
    }),
  );
  return { histories, unreadable } satisfies LoadedHistories;
}

function toDetections(
  lists: ConfigList[],
  histories: Map<string, SourceHistory>,
) {
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

function listName({ list, source }: Detection) {
  const title = list.catalogTitle.trim();
  if (title && !/^\d+$/u.test(title)) return title;
  return `your ${PROVIDERS[source.provider].label} ${storedSourceNoun(source.provider, source.sourceRef)}`;
}

function withDetectionLine(
  meta: StremioMeta & DigitalRelease,
  detection: Detection,
) {
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
export async function getDetectedMetas(
  access: AccountAccess,
  draftSources?: SourceId[],
) {
  const lists = await getVisibleLists(access);
  const included = draftSources && new Set(draftSources.map(sourceKey));
  const caches = lists
    .flatMap(sourceCaches)
    .filter(({ source }) => !included || included.has(sourceKey(source)));
  const sources = caches.map(({ source }) => source);
  if (sources.length === 0) return [];
  const { histories } = await loadHistories(access.account.id, sources);
  const detections = toDetections(lists, histories);
  if (detections.length === 0) return [];

  const cached = await Promise.all(
    caches.map(async ({ source, cacheKey }) => {
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
    const meta =
      metasBySource.get(sourceKey(detection.source))?.get(detection.imdbId) ??
      [...metasBySource.values()]
        .map((metas) => metas.get(detection.imdbId))
        .find((found) => !!found);
    if (!meta) return [];
    return [withDetectionLine(toFilterableMeta(meta), detection)];
  });
}

/** Date Added sorts by input position. Detected metas arrive newest first. */
export function selectNewTitlesCatalog(
  metas: StremioMeta[],
  {
    sortOption,
    catalogSettings,
  }: Pick<NewTitlesSettings, "sortOption" | "catalogSettings">,
  { type, preset }: ListCatalog,
  accountId: string,
) {
  const savedSort =
    sortOption === "detected_at-desc"
      ? "added_at-asc"
      : sortOption === "detected_at-asc"
        ? "added_at-desc"
        : sortOption;
  const { sort, filters } = resolveCatalogSelection(
    savedSort,
    catalogSettings,
    null,
    preset ?? undefined,
  );
  return filterCatalog(
    sortCatalog(metas, sort, `new-titles:${accountId}`).filter(
      (meta) => meta.type === type,
    ),
    filters,
  );
}

/**
 * What the configure page says about the "New titles" catalog. Null when the
 * history cannot be read: the page then shows only the setting.
 */
export async function getNewTitlesSummary(
  access: AccountAccess,
  allLists: ConfigList[],
) {
  const lists = visibleLists(access, allLists);
  if (lists.length === 0) {
    return { detected: 0, latestDetectedAt: null, waitingLists: 0 };
  }
  const { histories, unreadable } = await loadHistories(
    access.account.id,
    [...sourcesOf(lists).values()].map(({ source }) => source),
  );
  if (unreadable > 0) return null;
  const detections = toDetections(lists, histories);
  return {
    detected: detections.length,
    latestDetectedAt: detections[0]?.detectedAt.toISOString() ?? null,
    waitingLists: lists.filter((list) =>
      listSources(list).some((source) => !histories.has(sourceKey(source))),
    ).length,
  };
}
