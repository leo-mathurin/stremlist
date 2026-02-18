import { Hono } from "hono";
import { getWatchlist } from "../services/watchlist.js";

const catalog = new Hono();

catalog.get("/:userId/catalog/:type/:id.json", async (c) => {
  const userId = c.req.param("userId");
  const type = c.req.param("type");

  try {
    const watchlistData = await getWatchlist(userId);
    const metas = watchlistData.metas.filter((item) => item.type === type);

    console.log(
      `Serving catalog for user ${userId}, type: ${type}, found: ${metas.length} items`,
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
