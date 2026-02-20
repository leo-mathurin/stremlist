import { Hono } from "hono";
import { parseCatalogId } from "../services/catalog-id";
import {
  getUserRpdbApiKey,
  getUserWatchlistById,
  getUserWatchlists,
} from "../services/user";
import { getWatchlistByConfig } from "../services/watchlist";

const catalog = new Hono();
const CATALOG_DEBUG_PREFIX = "[catalog-route]";

interface CatalogWatchlistConfig {
  id: string;
  imdbUserId: string;
  sortOption: string;
}

catalog.get("/:userId/catalog/:type/:id.json", async (c) => {
  const userId = c.req.param("userId");
  const requestedType = c.req.param("type");
  const catalogId = c.req.param("id");
  const catalogIdWithSuffixKey = c.req.param("id.json");
  const normalizedCatalogId =
    catalogId ?? catalogIdWithSuffixKey.replace(/\.json$/u, "");

  try {
    console.debug(
      `${CATALOG_DEBUG_PREFIX} request received`,
      JSON.stringify({ userId, requestedType, catalogId }),
    );

    if (!userId || !requestedType || !normalizedCatalogId) {
      console.warn(
        `${CATALOG_DEBUG_PREFIX} missing route params`,
        JSON.stringify({ userId, requestedType, catalogId, normalizedCatalogId }),
      );
      return c.json({ metas: [] });
    }

    if (requestedType !== "movie" && requestedType !== "series") {
      console.warn(
        `${CATALOG_DEBUG_PREFIX} unsupported requested type`,
        JSON.stringify({ userId, requestedType, catalogId }),
      );
      return c.json({ metas: [] });
    }

    let watchlistConfig: CatalogWatchlistConfig | null = null;
    const parsedCatalog = parseCatalogId(normalizedCatalogId);
    console.debug(
      `${CATALOG_DEBUG_PREFIX} parsed catalog id`,
      JSON.stringify({ userId, catalogId, parsedCatalog }),
    );

    if (parsedCatalog?.type === requestedType) {
      console.debug(
        `${CATALOG_DEBUG_PREFIX} resolving modern catalog id`,
        JSON.stringify({
          userId,
          catalogId,
          watchlistId: parsedCatalog.watchlistId,
          requestedType,
        }),
      );
      const resolvedWatchlist = (await getUserWatchlistById(
        userId,
        parsedCatalog.watchlistId,
      )) as CatalogWatchlistConfig | null;
      watchlistConfig = resolvedWatchlist;
    } else {
      const legacyCatalogId =
        requestedType === "movie"
          ? `stremlist-movies-${userId}`
          : `stremlist-series-${userId}`;
      console.debug(
        `${CATALOG_DEBUG_PREFIX} checking legacy catalog id`,
        JSON.stringify({ userId, catalogId, legacyCatalogId }),
      );
      if (normalizedCatalogId === legacyCatalogId) {
        const watchlists = (await getUserWatchlists(
          userId,
        )) as CatalogWatchlistConfig[];
        const firstWatchlist = watchlists.at(0) ?? null;
        console.debug(
          `${CATALOG_DEBUG_PREFIX} legacy catalog resolved to first watchlist`,
          JSON.stringify({
            userId,
            watchlistsFound: watchlists.length,
            selectedWatchlistId: firstWatchlist?.id ?? null,
          }),
        );
        watchlistConfig = firstWatchlist;
      }
    }

    if (!watchlistConfig) {
      console.warn(
        `Unknown catalog id/type for user ${userId}: ${requestedType}/${normalizedCatalogId}`,
      );
      return c.json({ metas: [] });
    }

    console.debug(
      `${CATALOG_DEBUG_PREFIX} watchlist config selected`,
      JSON.stringify({
        userId,
        catalogId,
        normalizedCatalogId,
        watchlistId: watchlistConfig.id,
        watchlistImdbUserId: watchlistConfig.imdbUserId,
        watchlistSortOption: watchlistConfig.sortOption,
      }),
    );

    const rpdbApiKey = await getUserRpdbApiKey(userId);
    console.debug(
      `${CATALOG_DEBUG_PREFIX} loaded RPDB key state`,
      JSON.stringify({ userId, hasRpdbApiKey: Boolean(rpdbApiKey) }),
    );

    const watchlistData = await getWatchlistByConfig({
      ownerUserId: userId,
      watchlistId: watchlistConfig.id,
      imdbUserId: watchlistConfig.imdbUserId,
      sortOption: watchlistConfig.sortOption,
      rpdbApiKey,
    });
    console.debug(
      `${CATALOG_DEBUG_PREFIX} watchlist data loaded`,
      JSON.stringify({
        userId,
        watchlistId: watchlistConfig.id,
        totalMetas: watchlistData.metas.length,
      }),
    );

    const metas = watchlistData.metas.filter(
      (item) => item.type === requestedType,
    );

    console.log(
      `${CATALOG_DEBUG_PREFIX} serving catalog`,
      JSON.stringify({
        userId,
        requestedType,
        catalogId: normalizedCatalogId,
        watchlistId: watchlistConfig.id,
        metasReturned: metas.length,
      }),
    );

    return c.json({ metas });
  } catch (err) {
    console.error(
      `${CATALOG_DEBUG_PREFIX} error serving catalog for ${userId}:`,
      (err as Error).message,
    );
    return c.json({ metas: [] }, 500);
  }
});

export default catalog;
