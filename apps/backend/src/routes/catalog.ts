import type { ProviderId } from "@stremlist/shared/providers";
import {
  PROVIDERS,
  sourceRequiresConnection,
} from "@stremlist/shared/providers";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { Hono } from "hono";
import type { Context } from "hono";
import type { SourceUnavailableReason } from "../providers/types";
import { getAccountListById, resolveAccountKey } from "../services/accounts";
import {
  resolveCatalogSelection,
  filterCatalog,
} from "../services/catalog-filters";
import { parseCatalogId } from "../services/catalog-id";
import { getListCatalog, ListUnavailableError } from "../services/lists";

const catalog = new Hono();
const CATALOG_PAGE_SIZE = 100;

function unavailableCopy(
  provider: ProviderId,
  reason: Exclude<SourceUnavailableReason, "unavailable">,
): { name: string; description: string } {
  const label = PROVIDERS[provider].label;
  switch (reason) {
    case "private":
      return provider === "imdb"
        ? {
            name: "⚠️ This IMDb watchlist is private",
            description:
              "Make your watchlist public in your IMDb settings, then reopen this catalog in Stremio.",
          }
        : {
            name: `⚠️ This ${label} list is private`,
            description: `Make the list public on ${label}, or connect your ${label} account in Stremlist, then reopen this catalog.`,
          };
    case "not_found":
      return provider === "imdb"
        ? {
            name: "⚠️ IMDb watchlist not found",
            description:
              "We couldn't find this IMDb watchlist. Check the IMDb ID in your Stremlist configuration.",
          }
        : {
            name: `⚠️ ${label} list not found`,
            description: `We couldn't find this ${label} list. Check it in your Stremlist configuration.`,
          };
    case "needs_connection":
      return {
        name: `⚠️ Connect your ${label} account`,
        description: `This list needs your ${label} account. Open the Stremlist configure page and connect ${label} again.`,
      };
    case "disabled":
      return {
        name: `⚠️ ${label} is temporarily unavailable`,
        description: `Stremlist shows this list again as soon as ${label} works again.`,
      };
    case "premium_only":
      return {
        name: `⚠️ This ${label} list needs a paid ${label} plan`,
        description: `${label} only shares this list with paid accounts.`,
      };
    case "coming_soon":
      return {
        name: `⚠️ ${label} support is coming soon`,
        description: `Stremlist cannot read ${label} lists yet.`,
      };
  }
}

// A single informational card Stremio renders inside the catalog row, so the
// user sees *why* it's empty (e.g. their list is private) instead of a
// silent blank or a 500 the client retry-storms.
function buildUnavailableMeta(
  provider: ProviderId,
  reason: Exclude<SourceUnavailableReason, "unavailable">,
  type: "movie" | "series",
): StremioMeta {
  return {
    id: `stremlist:unavailable:${reason}`,
    type,
    ...unavailableCopy(provider, reason),
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
        metas: [
          buildUnavailableMeta(
            err.provider,
            err.reason,
            requestedType as "movie" | "series",
          ),
        ],
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
