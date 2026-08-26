import type { StremioMeta, WatchlistData } from "@stremlist/shared";

interface Entry {
  data: WatchlistData;
  cachedAt: Date;
  generation: string;
}

class InMemoryWatchlistCache {
  private entries = new Map<string, Entry>();

  reset(): void {
    this.entries.clear();
  }

  seed(watchlistId: string, metas: StremioMeta[], cachedAt = new Date()): void {
    this.entries.set(watchlistId, {
      data: { metas: structuredClone(metas) },
      cachedAt,
      generation: `${watchlistId}:${cachedAt.toISOString()}`,
    });
  }

  get(watchlistId: string): Entry | null {
    return this.entries.get(watchlistId) ?? null;
  }

  delete(watchlistId: string): void {
    this.entries.delete(watchlistId);
  }
}

export const cache = new InMemoryWatchlistCache();

export function getCachedWatchlist(watchlistId: string): Promise<Entry | null> {
  return Promise.resolve(cache.get(watchlistId));
}

export function writeCachedWatchlist(
  watchlistId: string,
  watchlistData: WatchlistData,
  cachedAt = new Date(),
): Promise<string> {
  const seen = new Set<string>();
  const metas = watchlistData.metas.filter((meta) => {
    const key = `${meta.type}:${meta.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (metas.length === 0) cache.delete(watchlistId);
  else cache.seed(watchlistId, metas, cachedAt);
  return Promise.resolve(`${watchlistId}:${cachedAt.toISOString()}`);
}

export function findCachedMeta(
  watchlistIds: string[],
  type: string,
  id: string,
): Promise<StremioMeta | null> {
  for (const watchlistId of watchlistIds) {
    const found = cache
      .get(watchlistId)
      ?.data.metas.find((meta) => meta.type === type && meta.id === id);
    if (found) return Promise.resolve(found);
  }
  return Promise.resolve(null);
}

export function deleteCachedWatchlist(watchlistId: string): Promise<void> {
  cache.delete(watchlistId);
  return Promise.resolve();
}
