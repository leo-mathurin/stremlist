import type { ConfigWatchlist, StremioMeta } from "@stremlist/shared";
import { Hono } from "hono";
import type { Context } from "hono";
import { parseCatalogId } from "../services/catalog-id";
import { getUserRpdbApiKey, getUserWatchlistById } from "../services/user";
import {
  getWatchlistByConfig,
  WatchlistUnavailableError,
} from "../services/watchlist";

const catalog = new Hono();
const CATALOG_PAGE_SIZE = 100;

// A single informational card Stremio renders inside the catalog row, so the
// user sees *why* it's empty (e.g. their IMDb list is private) instead of a
// silent blank or a 500 the client retry-storms.
function buildUnavailableMeta(
  reason: "private" | "not_found",
  type: "movie" | "series",
): StremioMeta {
  const copy =
    reason === "private"
      ? {
          name: "⚠️ This IMDb watchlist is private",
          description:
            "Make your watchlist public in your IMDb settings, then reopen this catalog in Stremio.",
        }
      : {
          name: "⚠️ IMDb watchlist not found",
          description:
            "We couldn't find this IMDb watchlist. Check the IMDb ID in your Stremlist configuration.",
        };

  return {
    id: `stremlist:unavailable:${reason}`,
    type,
    name: copy.name,
    description: copy.description,
    poster: null,
    posterShape: "poster",
    genres: [],
  };
}

function parseSkip(c: Context): number | null {
  const extra = routeParam(c, "extra");
  const value = extra
    ? new URLSearchParams(extra.replace(/\.json$/u, "")).get("skip")
    : c.req.query("skip");
  if (value === undefined || value === null || value === "") return 0;

  const skip = Number(value);
  return Number.isSafeInteger(skip) && skip >= 0 ? skip : null;
}

function routeParam(c: Context, name: string): string | undefined {
  const params = c.req.param() as Record<string, string | undefined>;
  return params[name] ?? params[`${name}.json`];
}

async function serveCatalog(c: Context) {
  c.header("Cache-Control", "no-store");
  const userId = c.req.param("userId");
  const requestedType = c.req.param("type");
  const catalogId = (routeParam(c, "id") ?? "").replace(/\.json$/u, "");

  try {
    if (!userId || !requestedType || !catalogId) {
      console.warn(
        `Missing route params`,
        JSON.stringify({
          userId,
          requestedType,
          catalogId,
        }),
      );
      return c.json({ metas: [] });
    }

    if (requestedType !== "movie" && requestedType !== "series") {
      return c.json({ metas: [] });
    }

    const skip = parseSkip(c);
    if (skip === null) {
      return c.json({ metas: [] }, 400);
    }

    const parsedCatalog = parseCatalogId(catalogId);
    if (!parsedCatalog?.type || parsedCatalog.type !== requestedType) {
      console.warn(
        `Unknown catalog id for user ${userId}: ${requestedType}/${catalogId}`,
      );
      return c.json({ metas: [] });
    }

    const watchlistConfig: ConfigWatchlist | null = await getUserWatchlistById(
      userId,
      parsedCatalog.watchlistId,
    );

    if (!watchlistConfig) {
      console.warn(
        `Watchlist not found for user ${userId}: ${parsedCatalog.watchlistId}`,
      );
      return c.json({ metas: [] });
    }

    const rpdbApiKey = await getUserRpdbApiKey(userId);

    const watchlistData = await getWatchlistByConfig({
      ownerUserId: userId,
      watchlistId: watchlistConfig.id,
      imdbUserId: watchlistConfig.imdbUserId,
      sortOption: watchlistConfig.sortOption,
      rpdbApiKey,
    });

    const matchingMetas = watchlistData.metas.filter(
      (item) => item.type === requestedType,
    );
    const metas = matchingMetas.slice(skip, skip + CATALOG_PAGE_SIZE);

    console.log(
      `Serving catalog for user ${userId}, type: ${requestedType}, watchlist: ${watchlistConfig.id}, skip: ${skip}, page items: ${metas.length}, total items: ${matchingMetas.length}`,
    );

    return c.json({ metas });
  } catch (err) {
    // Expected user-state (private / not-found list, no cache to fall back on):
    // return 200 with an informational card so Stremio shows the user *why* the
    // catalog is empty instead of a 500 it would retry-storm — that retry storm
    // on private watchlists was the dominant prod error flood.
    if (
      err instanceof WatchlistUnavailableError &&
      err.reason !== "unavailable"
    ) {
      console.warn(
        `Catalog unavailable for ${userId} (${err.reason}): ${requestedType}/${catalogId}`,
      );
      return c.json({
        metas: [
          buildUnavailableMeta(err.reason, requestedType as "movie" | "series"),
        ],
      });
    }

    // Genuine or transient server error → keep the 500 (visible in monitoring;
    // Stremio may retry, which is appropriate for a transient failure).
    console.error(
      `Error serving catalog for ${userId}:`,
      (err as Error).message,
    );
    return c.json({ metas: [] }, 500);
  }
}

catalog.get("/:userId/catalog/:type/:id/:extra.json", serveCatalog);
catalog.get("/:userId/catalog/:type/:id.json", serveCatalog);

export default catalog;
