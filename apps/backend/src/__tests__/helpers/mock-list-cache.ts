import type {
  StremioMeta,
  WatchlistData,
} from "@stremlist/shared/stremio.types";

interface Entry {
  data: WatchlistData;
  cachedAt: Date;
  generation: string;
}

class InMemoryListCache {
  private entries = new Map<string, Entry>();

  reset(): void {
    this.entries.clear();
  }

  seed(listId: string, metas: StremioMeta[], cachedAt = new Date()): void {
    this.entries.set(listId, {
      data: { metas: structuredClone(metas) },
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

export function getCachedList(listId: string): Promise<Entry | null> {
  return Promise.resolve(cache.get(listId));
}

export function writeCachedList(
  listId: string,
  listData: WatchlistData,
  cachedAt = new Date(),
): Promise<string> {
  const seen = new Set<string>();
  const metas = listData.metas.filter((meta) => {
    const key = `${meta.type}:${meta.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (metas.length === 0) cache.delete(listId);
  else cache.seed(listId, metas, cachedAt);
  return Promise.resolve(`${listId}:${cachedAt.toISOString()}`);
}

export function findCachedMeta(
  listIds: string[],
  type: string,
  id: string,
): Promise<StremioMeta | null> {
  for (const listId of listIds) {
    const found = cache
      .get(listId)
      ?.data.metas.find((meta) => meta.type === type && meta.id === id);
    if (found) return Promise.resolve(found);
  }
  return Promise.resolve(null);
}

export function deleteCachedList(listId: string): Promise<void> {
  cache.delete(listId);
  return Promise.resolve();
}

export function getCachedListSummary(listId: string) {
  const entry = cache.get(listId);
  if (!entry) return Promise.resolve(null);
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
  if (entry) cache.seed(listId, entry.data.metas, new Date(0));
  return Promise.resolve();
}
