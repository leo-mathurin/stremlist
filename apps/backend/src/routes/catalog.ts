import type { ConfigWatchlist } from "@stremlist/shared";
import { STREMIO_PAGE_SIZE } from "@stremlist/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { parseCatalogExtras } from "../services/catalog-extras";
import { parseCatalogId } from "../services/catalog-id";
import { getUserRpdbApiKey, getUserWatchlistById } from "../services/user";
import { getWatchlistByConfig } from "../services/watchlist";

const catalog = new Hono();

async function handleCatalog(c: Context, extra: string | undefined) {
  const userId = c.req.param("userId");
  const requestedType = c.req.param("type");
  // Hono names the param `id.json` for the literal-suffix route and `id` for
  // the regex route — read both via the params record.
  const params = c.req.param() as Record<string, string | undefined>;
  const catalogId = (params.id ?? params["id.json"] ?? "").replace(
    /\.json$/u,
    "",
  );

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

    const filtered = watchlistData.metas.filter(
      (item) => item.type === requestedType,
    );

    const { skip } = parseCatalogExtras(extra);
    const page = filtered.slice(skip, skip + STREMIO_PAGE_SIZE);

    console.log(
      `Serving catalog for user ${userId}, type: ${requestedType}, watchlist: ${watchlistConfig.id}, items: ${page.length}/${filtered.length} (skip=${skip})`,
    );

    return c.json({ metas: page });
  } catch (err) {
    console.error(
      `Error serving catalog for ${userId}:`,
      (err as Error).message,
    );
    return c.json({ metas: [] }, 500);
  }
}

// With extras (e.g. `/skip=100.json`). Registered before the no-extras route
// so the more specific pattern wins on match.
catalog.get("/:userId/catalog/:type/:id/:extra{.+\\.json}", (c) =>
  handleCatalog(c, c.req.param("extra")),
);

// No extras — preserved for clients with cached pre-1.3.1 manifests.
catalog.get("/:userId/catalog/:type/:id.json", (c) =>
  handleCatalog(c, undefined),
);

export default catalog;
