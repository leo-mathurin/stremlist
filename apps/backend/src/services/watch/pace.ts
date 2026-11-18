import { RateLimiter } from "../../providers/http";
import { getLibraryItems, getLibraryMeta, hasStremioTrakt } from "../stremio";

const STREMIO_READS_PER_SECOND = 20;
const limiter = new RateLimiter(STREMIO_READS_PER_SECOND, 1000);

export async function readLibraryItems(authKey: string, ids: string[]) {
  await limiter.acquire();
  return getLibraryItems(authKey, ids);
}

export async function readLibraryMeta(authKey: string) {
  await limiter.acquire();
  return getLibraryMeta(authKey);
}

export async function readStremioTrakt(authKey: string) {
  await limiter.acquire();
  return hasStremioTrakt(authKey);
}
