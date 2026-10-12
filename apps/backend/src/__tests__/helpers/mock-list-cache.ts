import type { Tables } from "@stremlist/shared/database.types";
import {
  isProviderId,
  sourceRequiresConnection,
} from "@stremlist/shared/providers";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { isCurrentConnection } from "../../services/connection-identity";
import type { ConnectionIdentity } from "../../services/connection-identity";
import type { SourceMeta, SourceCatalogData } from "../../services/list-cache";
import { mapList } from "../../services/list-rows";
import { sourceCaches } from "../../services/merged-lists";
import { db } from "./mock-supabase";

interface Entry {
  data: SourceCatalogData;
  cachedAt: Date;
  generation: string;
  source?: string;
  connection?: ConnectionIdentity;
}

interface CacheSource {
  provider: string;
  sourceRef: string;
}

function sourceKey(source?: CacheSource): string | undefined {
  return source && `${source.provider}:${source.sourceRef}`;
}

async function servesSource(
  entry: Entry,
  source?: CacheSource,
): Promise<boolean> {
  if (entry.connection) {
    if (!(await isCurrentConnection(entry.connection))) return false;
  } else if (
    source &&
    isProviderId(source.provider) &&
    sourceRequiresConnection(source.provider, source.sourceRef)
  )
    return false;
  return !source || !entry.source || entry.source === sourceKey(source);
}

class InMemoryListCache {
  private entries = new Map<string, Entry>();

  reset(): void {
    this.entries.clear();
  }

  seed(
    listId: string,
    metas: SourceMeta[],
    cachedAt = new Date(),
    source?: CacheSource,
    connection?: ConnectionIdentity,
  ): void {
    // Seed a snapshot as if the configured Source list had just been read.
    const owner = db
      .getTable("lists")
      .flatMap((row) => {
        const list = mapList(row as Tables<"lists">);
        return list
          ? sourceCaches(list).map((cache) => ({
              ...cache,
              accountId: row.account_id,
            }))
          : [];
      })
      .find((cache) => cache.cacheKey === listId);
    const stored =
      owner &&
      db
        .getTable("connections")
        .find(
          (row) =>
            row.account_id === owner.accountId &&
            row.provider === owner.source.provider,
        );
    if (
      !connection &&
      stored &&
      typeof owner.accountId === "string" &&
      typeof stored.authorization_version === "string"
    ) {
      connection = {
        accountId: owner.accountId,
        provider: owner.source.provider,
        authorization: stored.authorization_version,
      };
    }
    this.entries.set(listId, {
      data: { metas: structuredClone(metas) },
      cachedAt,
      generation: `${listId}:${cachedAt.toISOString()}`,
      source: sourceKey(source),
      connection,
    });
  }

  markStale(listId: string, entry: Entry): void {
    const cachedAt = new Date(0);
    this.entries.set(listId, {
      ...entry,
      cachedAt,
      generation: `${listId}:${cachedAt.toISOString()}`,
    });
  }

  get(listId: string): Entry | null {
    return this.entries.get(listId) ?? null;
  }

  delete(listId: string): void {
    this.entries.delete(listId);
  }
}

export const cache = new InMemoryListCache();

export async function getCachedList(
  listId: string,
  source?: CacheSource,
): Promise<Entry | null> {
  const entry = cache.get(listId);
  return Promise.resolve(
    entry && (await servesSource(entry, source)) ? entry : null,
  );
}

export function writeCachedList(
  listId: string,
  listData: SourceCatalogData,
  cachedAt = new Date(),
  source?: CacheSource,
  connection?: ConnectionIdentity,
): Promise<string> {
  const seen = new Set<string>();
  const metas = listData.metas.filter((meta) => {
    const key = `${meta.type}:${meta.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (metas.length === 0) cache.delete(listId);
  else cache.seed(listId, metas, cachedAt, source, connection);
  return Promise.resolve(`${listId}:${cachedAt.toISOString()}`);
}

export async function findCachedMeta(
  listId: string,
  type: string,
  id: string,
  source?: CacheSource,
): Promise<StremioMeta | null> {
  const entry = cache.get(listId);
  if (!entry || !(await servesSource(entry, source))) return null;
  const found = cache
    .get(listId)
    ?.data.metas.find((meta) => meta.type === type && meta.id === id);
  return Promise.resolve(found ?? null);
}

export function deleteCachedList(listId: string): Promise<void> {
  cache.delete(listId);
  return Promise.resolve();
}

export async function getCachedListSummary(
  listId: string,
  source?: CacheSource,
) {
  const entry = cache.get(listId);
  if (!entry || !(await servesSource(entry, source)))
    return Promise.resolve(null);
  const genres = (type: StremioMeta["type"]) =>
    [
      ...new Set(
        entry.data.metas
          .filter((meta) => meta.type === type)
          .flatMap((meta) => meta.genres)
          .filter((genre) => genre.trim().length > 0),
      ),
    ].sort();
  return Promise.resolve({ movie: genres("movie"), series: genres("series") });
}

export function markCachedListStale(listId: string): Promise<void> {
  const entry = cache.get(listId);
  if (entry) cache.markStale(listId, entry);
  return Promise.resolve();
}

export async function getCachedListInfo(listId: string, source?: CacheSource) {
  const entry = cache.get(listId);
  if (
    !entry ||
    !(await servesSource(entry, source)) ||
    entry.cachedAt.getTime() <= 0
  ) {
    return Promise.resolve(null);
  }
  return Promise.resolve({
    cachedAt: entry.cachedAt.toISOString(),
    titleCount: entry.data.metas.length,
  });
}
