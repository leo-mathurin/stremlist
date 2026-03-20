import type { ConfigWatchlist } from "@stremlist/shared";
import { Hono } from "hono";
import { parseCatalogId } from "../services/catalog-id";
import { getUserRpdbApiKey, getUserWatchlistById } from "../services/user";
import { getWatchlistByConfig } from "../services/watchlist";

const catalog = new Hono();

catalog.get("/:userId/catalog/:type/:id.json", async (c) => {
  const userId = c.req.param("userId");
  const requestedType = c.req.param("type");
  const catalogId = (c.req.param("id") ?? c.req.param("id.json")).replace(
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

    const metas = watchlistData.metas.filter(
      (item) => item.type === requestedType,
    );

    console.log(
      `Serving catalog for user ${userId}, type: ${requestedType}, watchlist: ${watchlistConfig.id}, items: ${metas.length}`,
    );

    return c.json({ metas });
  } catch (err) {
    console.error(
      `Error serving catalog for ${userId}:`,
      (err as Error).message,
    );
    return c.json({ metas: [] }, 500);
  }
});

export default catalog;
