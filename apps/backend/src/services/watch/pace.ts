/**
 * Every Watch tracking call to `api.strem.io` from one instance goes
 * through one limiter: at most 20 a second, the rate of the controlled test
 * (ADR 0003). Reads over it wait; a cron run then claims fewer.
 */
import { RateLimiter } from "../../providers/http";
import type { LibraryItem } from "../stremio";
import { getLibraryItems, getLibraryMeta, hasStremioTrakt } from "../stremio";

const STREMIO_READS_PER_SECOND = 20;
const limiter = new RateLimiter(STREMIO_READS_PER_SECOND, 1000);

export async function readLibraryItems(
  authKey: string,
  ids: string[],
): Promise<LibraryItem[]> {
  await limiter.acquire();
  return getLibraryItems(authKey, ids);
}

export async function readLibraryMeta(
  authKey: string,
): Promise<[string, number][]> {
  await limiter.acquire();
  return getLibraryMeta(authKey);
}

export async function readStremioTrakt(authKey: string): Promise<boolean> {
  await limiter.acquire();
  return hasStremioTrakt(authKey);
}
