import { sourceRequiresConnection } from "@stremlist/shared/providers";
import {
  sourceProblemCopy,
  storedSourceNoun,
} from "@stremlist/shared/source-problems";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { Hono } from "hono";
import type { Context } from "hono";
import { getAccountListById, resolveAccountKey } from "../services/accounts";
import {
  resolveCatalogSelection,
  filterCatalog,
} from "../services/catalog-filters";
import {
  parseCatalogId,
  parseNewTitlesCatalogId,
} from "../services/catalog-id";
import { getNewTitlesCatalog } from "../services/detections";
import { getListCatalog, ListUnavailableError } from "../services/lists";

const catalog = new Hono();
const CATALOG_PAGE_SIZE = 100;

// A single informational card Stremio renders inside the catalog row, so the
// user sees *why* it's empty (e.g. their list is private) instead of a
// silent blank or a 500 the client retry-storms.
function buildUnavailableMeta(
  error: ListUnavailableError,
  type: "movie" | "series",
): StremioMeta {
  const { title, fix } = sourceProblemCopy(
    error.provider,
    error.reason,
    storedSourceNoun(error.provider, error.sourceRef),
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

function catalogExtra(c: Context): URLSearchParams {
  const url = new URL(c.req.url);
  // Hono decodes route params. Read the raw segment to keep encoded & and +
  // inside search terms instead of treating them as parameter separators.
  return routeParam(c, "extra")
    ? new URLSearchParams(
        url.pathname
          .slice(url.pathname.lastIndexOf("/") + 1)
          .replace(/\.json$/u, ""),
      )
    : new URLSearchParams(url.search);
}

function parseSkip(extra: URLSearchParams): number | null {
  const value = extra.get("skip");
  if (value === null || value === "") return 0;

  const skip = Number(value);
  return Number.isSafeInteger(skip) && skip >= 0 ? skip : null;
}

function routeParam(c: Context, name: string): string | undefined {
  const params = c.req.param() as Record<string, string | undefined>;
  return params[name] ?? params[`${name}.json`];
}

async function serveCatalog(c: Context) {
  c.header("Cache-Control", "no-store");
  const accountKey = c.req.param("accountKey");
  const requestedType = c.req.param("type");
  const catalogId = (routeParam(c, "id") ?? "").replace(/\.json$/u, "");

  try {
    if (!accountKey || !requestedType || !catalogId) {
      console.warn(
        `Missing route params`,
        JSON.stringify({
          accountKey,
          requestedType,
          catalogId,
        }),
      );
      return c.json({ metas: [] });
    }

    if (requestedType !== "movie" && requestedType !== "series") {
      return c.json({ metas: [] });
    }

    const extra = catalogExtra(c);
    const filter = extra.get("genre");
    const skip = parseSkip(extra);
    if (skip === null) {
      return c.json({ metas: [] }, 400);
    }

    const newTitlesType = parseNewTitlesCatalogId(catalogId);
    if (newTitlesType) {
      if (newTitlesType !== requestedType || extra.has("search")) {
        return c.json({ metas: [] });
      }
      const access = await resolveAccountKey(accountKey);
      if (!access?.account.newTitlesCatalog) return c.json({ metas: [] });
      const metas = await getNewTitlesCatalog(access, newTitlesType);
      return c.json({ metas: metas.slice(skip, skip + CATALOG_PAGE_SIZE) });
    }

    const parsedCatalog = parseCatalogId(catalogId);
    if (!parsedCatalog?.type || parsedCatalog.type !== requestedType) {
      console.warn(
        `Unknown catalog id for user ${accountKey}: ${requestedType}/${catalogId}`,
      );
      return c.json({ metas: [] });
    }

    const access = await resolveAccountKey(accountKey);
    if (!access) {
      return c.json({ metas: [] });
    }
    const list = await getAccountListById(
      access.account.id,
      parsedCatalog.listId,
    );

    if (!list) {
      console.warn(`List not found for ${accountKey}: ${parsedCatalog.listId}`);
      return c.json({ metas: [] });
    }
    // Lists read through a Connection never answer through a Legacy alias.
    if (
      access.via === "legacy" &&
      sourceRequiresConnection(list.provider, list.sourceRef)
    ) {
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

    const listData = await getListCatalog({
      accountId: access.account.id,
      listId: list.id,
      provider: list.provider,
      sourceRef: list.sourceRef,
      sort: selection.sort,
      rpdbApiKey: access.account.rpdbApiKey,
      allowConnection: access.via === "private",
    });

    const matchingMetas = filterCatalog(
      listData.metas.filter((item) => item.type === requestedType),
      selection.filters,
      extra.get("search"),
    );
    const metas = matchingMetas.slice(skip, skip + CATALOG_PAGE_SIZE);

    console.log(
      `Serving catalog for user ${accountKey}, type: ${requestedType}, list: ${list.id}, skip: ${skip}, page items: ${metas.length}, total items: ${matchingMetas.length}`,
    );

    return c.json({ metas });
  } catch (err) {
    // Expected user-state (private / not-found list, no cache to fall back on):
    // return 200 with an informational card so Stremio shows the user *why* the
    // catalog is empty instead of a 500 it would retry-storm — that retry storm
    // on private watchlists was the dominant prod error flood.
    if (err instanceof ListUnavailableError && err.reason !== "unavailable") {
      console.warn(
        `Catalog unavailable for ${accountKey} (${err.reason}): ${requestedType}/${catalogId}`,
      );
      // Informational cards explain empty catalogs, but aren't search matches.
      if (catalogExtra(c).has("search")) {
        return c.json({ metas: [] });
      }
      return c.json({
        metas: [buildUnavailableMeta(err, requestedType as "movie" | "series")],
      });
    }

    // Genuine or transient server error → keep the 500 (visible in monitoring;
    // Stremio may retry, which is appropriate for a transient failure).
    console.error(
      `Error serving catalog for ${accountKey}:`,
      (err as Error).message,
    );
    return c.json({ metas: [] }, 500);
  }
}

catalog.get("/:accountKey/catalog/:type/:id/:extra.json", serveCatalog);
catalog.get("/:accountKey/catalog/:type/:id.json", serveCatalog);

export default catalog;
