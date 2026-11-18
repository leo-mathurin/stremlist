import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { connectionIdentitySchema } from "../../services/connection-identity";
import type { ConnectionIdentity } from "../../services/connection-identity";
import { forgetMemoryCache } from "../../services/list-cache";
import type { SourceMeta, SourceCatalogData } from "../../services/list-cache";
import { mapList } from "../../services/list-rows";
import { sourceCaches } from "../../services/merged-lists";
import {
  putR2Bytes,
  r2Bytes,
  r2Objects,
  r2Puts,
  r2Unwritable,
} from "./r2.test-utils";
import { db } from "./mock-supabase";
import { listRow } from "./rows";

interface CacheSource {
  provider: string;
  sourceRef: string;
}

function sourceKey(source?: CacheSource) {
  return source && `${source.provider}:${source.sourceRef}`;
}

const manifestSchema = z.object({
  generation: z.string(),
  cachedAt: z.string(),
  catalogKey: z.string(),
  source: z.string().optional(),
  connection: connectionIdentitySchema.optional(),
});

const catalogSchema = z.object({ metas: z.array(z.custom<SourceMeta>()) });

function prefixOf(listId: string) {
  return `watchlists/${listId}/`;
}

function manifestKeyOf(listId: string) {
  return `${prefixOf(listId)}manifest.json`;
}

function genresOf(metas: StremioMeta[], type: StremioMeta["type"]) {
  return [
    ...new Set(
      metas
        .filter((meta) => meta.type === type)
        .flatMap((meta) => meta.genres)
        .filter((genre) => genre.trim().length > 0),
    ),
  ].sort();
}

function storedConnection(listId: string) {
  const owner = db
    .getTable("lists")
    .flatMap((row) => {
      const list = mapList(listRow.parse(row));
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
    stored &&
    typeof owner.accountId === "string" &&
    typeof stored.authorization_version === "string"
  ) {
    return {
      accountId: owner.accountId,
      provider: owner.source.provider,
      authorization: stored.authorization_version,
    } satisfies ConnectionIdentity;
  }
  return undefined;
}

type BeforeWrite = (listId: string) => Promise<void>;

class ListCacheStore {
  private hook: BeforeWrite | null = null;

  readonly unwritable = {
    add: (listId: string) => {
      r2Unwritable.add(prefixOf(listId));
    },
    has: (listId: string) => r2Unwritable.has(prefixOf(listId)),
  };

  get beforeWrite() {
    return this.hook;
  }

  set beforeWrite(hook: BeforeWrite | null) {
    this.hook = hook;
    r2Puts.before = hook
      ? (key) => {
          const listId = /^watchlists\/(.+)\/manifest\.json$/.exec(key)?.[1];
          return listId === undefined ? undefined : hook(listId);
        }
      : null;
  }

  reset() {
    for (const key of r2Objects.keys()) {
      if (key.startsWith("watchlists/")) r2Objects.delete(key);
    }
    for (const prefix of r2Unwritable) {
      if (prefix.startsWith("watchlists/")) r2Unwritable.delete(prefix);
    }
    this.beforeWrite = null;
    forgetMemoryCache();
  }

  seed(
    listId: string,
    metas: SourceMeta[],
    cachedAt = new Date(),
    source?: CacheSource,
    connection: ConnectionIdentity | undefined = storedConnection(listId),
  ) {
    const generation = randomUUID();
    const catalogKey = `${prefixOf(listId)}generations/${generation}.json.gz`;
    const catalog = { version: 1, metas: structuredClone(metas) };
    putR2Bytes(catalogKey, gzipSync(Buffer.from(JSON.stringify(catalog))));
    const manifest = {
      version: 1,
      generation,
      cachedAt: cachedAt.toISOString(),
      catalogKey,
      metaKeys: metas.map((meta) => `${meta.type}:${meta.id}`).sort(),
      ...(source ? { source: sourceKey(source) } : {}),
      ...(connection ? { connection } : {}),
      genres: {
        movie: genresOf(metas, "movie"),
        series: genresOf(metas, "series"),
      },
    };
    r2Objects.set(manifestKeyOf(listId), JSON.stringify(manifest));
    forgetMemoryCache();
  }

  markStale(listId: string) {
    const raw = r2Objects.get(manifestKeyOf(listId));
    if (raw === undefined) return;
    const manifest = z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
    r2Objects.set(
      manifestKeyOf(listId),
      JSON.stringify({ ...manifest, cachedAt: new Date(0).toISOString() }),
    );
    forgetMemoryCache();
  }

  get(listId: string) {
    const raw = r2Objects.get(manifestKeyOf(listId));
    if (raw === undefined) return null;
    const parsed = manifestSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const manifest = parsed.data;
    const bytes = r2Bytes(manifest.catalogKey);
    if (bytes === undefined) return null;
    const catalog = catalogSchema.parse(
      JSON.parse(gunzipSync(bytes).toString("utf8")),
    );
    const data: SourceCatalogData = { metas: catalog.metas };
    return {
      data,
      cachedAt: new Date(manifest.cachedAt),
      generation: manifest.generation,
      source: manifest.source,
      connection: manifest.connection,
    };
  }

  delete(listId: string) {
    for (const key of r2Objects.keys()) {
      if (key.startsWith(prefixOf(listId))) r2Objects.delete(key);
    }
    forgetMemoryCache();
  }
}

/**
 * The cached Catalogs of the real list cache, read and written in the
 * in-memory R2 bucket in the format of `services/list-cache`. Each change
 * also makes the app forget what it keeps in memory, so its next read sees
 * the change, like the first read of a new instance. `get` gives a List's
 * Catalog as R2 holds it now; `beforeWrite` runs before the list cache
 * commits a write; `unwritable` Lists fail their writes.
 */
export const cache = new ListCacheStore();
