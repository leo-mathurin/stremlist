import type { TitleType } from "@stremlist/shared/constants";
import { DEFAULT_NEW_TITLES_SETTINGS } from "@stremlist/shared/manifest-catalogs";
import { queuedCatalogCopy } from "@stremlist/shared/provider-queue";
import {
  sourceProblemCopy,
  storedSourceNoun,
} from "@stremlist/shared/source-problems";
import { Hono } from "hono";
import type { Context } from "hono";
import { getVisibleListById, resolveAccountKey } from "../services/accounts";
import {
  resolveCatalogSelection,
  filterCatalog,
} from "../services/catalog-filters";
import { parseCatalogId } from "../services/catalog-id";
import {
  getDetectedMetas,
  selectNewTitlesCatalog,
} from "../services/detections";
import { getListCatalog, ListUnavailableError } from "../services/lists";
import { toStremioMeta } from "../services/merged-lists";
import {
  localizedTitlesForAccount,
  withAccountMetadata,
} from "../services/metadata";
import { withAccountPosters } from "../services/posters";

const catalog = new Hono();
const CATALOG_PAGE_SIZE = 100;

function buildUnavailableMeta(error: ListUnavailableError, type: TitleType) {
  const { title, fix } = sourceProblemCopy(
    error.provider,
    error.reason,
    storedSourceNoun(error.provider, error.sourceRef),
    error.sourceRef,
  );
  return {
    id: `stremlist:unavailable:${error.reason}`,
    type,
    name: `⚠️ ${title}`,
    description: fix,
    poster: null,
    posterShape: "poster",
    genres: [],
  };
}

function buildQueuedMeta(error: ListUnavailableError, type: TitleType) {
  const { title, description } = queuedCatalogCopy(error.provider);
  return {
    id: `stremlist:queued:${error.provider}`,
    type,
    name: title,
    description,
    poster: null,
    posterShape: "poster",
    genres: [],
  };
}

function catalogExtra(c: Context) {
  const url = new URL(c.req.url);
  return routeParam(c, "extra")
    ? new URLSearchParams(
        url.pathname
          .slice(url.pathname.lastIndexOf("/") + 1)
          .replace(/\.json$/u, ""),
      )
    : new URLSearchParams(url.search);
}

function parseSkip(extra: URLSearchParams) {
  const value = extra.get("skip");
  if (value === null || value === "") return 0;

  const skip = Number(value);
  return Number.isSafeInteger(skip) && skip >= 0 ? skip : null;
}

function routeParam(c: Context, name: string) {
  const params = c.req.param() as Record<string, string | undefined>;
  return params[name] ?? params[`${name}.json`];
}

async function serveCatalog(c: Context) {
  c.header("Cache-Control", "no-store");
  const accountKey = c.req.param("accountKey");
  const requestedType = c.req.param("type");
  const catalogId = (routeParam(c, "id") ?? "").replace(/\.json$/u, "");
  const titleType: TitleType | null =
    requestedType === "movie" || requestedType === "series"
      ? requestedType
      : null;

  try {
    if (!accountKey || !requestedType || !catalogId) {
      console.warn(
        `Missing route params`,
        JSON.stringify({ accountKey, requestedType, catalogId }),
      );
      return c.json({ metas: [] });
    }

    if (!titleType) {
      return c.json({ metas: [] });
    }

    const extra = catalogExtra(c);
    const filter = extra.get("genre");
    const skip = parseSkip(extra);
    if (skip === null) {
      return c.json({ metas: [] }, 400);
    }

    const parsedCatalog = parseCatalogId(catalogId);
    if (parsedCatalog?.type !== requestedType) {
      console.warn(
        `Unknown catalog id for user ${accountKey}: ${requestedType}/${catalogId}`,
      );
      return c.json({ metas: [] });
    }

    const access = await resolveAccountKey(accountKey);
    if (!access) {
      return c.json({ metas: [] });
    }

    if (parsedCatalog.kind === "new-titles") {
      if (!access.account.newTitlesCatalog || extra.has("search")) {
        return c.json({ metas: [] });
      }
      const settings =
        access.account.newTitlesSettings ?? DEFAULT_NEW_TITLES_SETTINGS;
      const { type, preset } = parsedCatalog;
      if (settings.displayMode !== "split" && settings.displayMode !== type) {
        return c.json({ metas: [] });
      }
      if (preset && !settings.catalogSettings?.presets?.includes(preset)) {
        return c.json({ metas: [] });
      }
      const metas = selectNewTitlesCatalog(
        await getDetectedMetas(access),
        settings,
        { type, preset: preset ?? null },
        access.account.id,
      );
      const withPosters = await withAccountPosters(
        metas.slice(skip, skip + CATALOG_PAGE_SIZE).map(toStremioMeta),
        access.account,
      );
      return c.json({
        metas: await withAccountMetadata(withPosters, access.account),
      });
    }

    const list = await getVisibleListById(access, parsedCatalog.listId);
    if (!list) {
      console.warn(`List not found for ${accountKey}: ${parsedCatalog.listId}`);
      return c.json({ metas: [] });
    }

    const preset = parsedCatalog.preset;
    if (preset && !list.catalogSettings?.presets?.includes(preset)) {
      return c.json({ metas: [] });
    }
    const selection = resolveCatalogSelection(
      list.sortOption,
      list.catalogSettings,
      filter,
      preset,
    );

    const listData = await getListCatalog(list, {
      accountId: access.account.id,
      sort: selection.sort,
      allowConnection: access.via === "private",
      policy: "catalog",
    });

    const search = extra.get("search");
    const filteredMetas = filterCatalog(
      listData.metas.filter((item) => item.type === requestedType),
      selection.filters,
    );
    const localizedNames = search?.trim()
      ? await localizedTitlesForAccount(filteredMetas, access.account)
      : undefined;
    const matchingMetas =
      search === null
        ? filteredMetas
        : filterCatalog(filteredMetas, [], search, localizedNames);
    const withPosters = await withAccountPosters(
      matchingMetas.slice(skip, skip + CATALOG_PAGE_SIZE).map(toStremioMeta),
      access.account,
    );
    const metas = await withAccountMetadata(withPosters, access.account);

    console.log(
      `Serving catalog for user ${accountKey}, type: ${requestedType}, list: ${list.id}, skip: ${skip}, page items: ${metas.length}, total items: ${matchingMetas.length}`,
    );

    return c.json({ metas });
  } catch (err) {
    if (
      err instanceof ListUnavailableError &&
      (err.queued || err.reason !== "unavailable") &&
      titleType
    ) {
      console.warn(
        `Catalog unavailable for ${accountKey} (${err.queued ? "queued" : err.reason}): ${requestedType}/${catalogId}`,
      );
      if (catalogExtra(c).has("search")) {
        return c.json({ metas: [] });
      }
      return c.json({
        metas: [
          err.queued
            ? buildQueuedMeta(err, titleType)
            : buildUnavailableMeta(err, titleType),
        ],
      });
    }

    console.error(
      `Error serving catalog for ${accountKey}:`,
      err instanceof Error ? err.message : err,
    );
    return c.json({ metas: [] }, 500);
  }
}

catalog.get("/:accountKey/catalog/:type/:id/:extra.json", serveCatalog);
catalog.get("/:accountKey/catalog/:type/:id.json", serveCatalog);

export default catalog;
