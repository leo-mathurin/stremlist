import { Hono } from "hono";
import { getWatchlist } from "../services/watchlist";

const meta = new Hono();

meta.get("/:userId/meta/:type/:id.json", async (c) => {
  const userId = c.req.param("userId");
  const type = c.req.param("type");
  const id = c.req.param("id");

  try {
    const watchlistData = await getWatchlist(userId);
    const item = watchlistData.metas.find(
      (m) => m.id === id && m.type === type,
    );

    if (!item) {
      console.log(
        `Meta not found for ${type}/${id} in user ${userId}'s watchlist`,
      );
      return c.json({ meta: null });
    }

    console.log(`Serving meta for ${userId}, type: ${type}, id: ${id}`);
    return c.json({ meta: item });
  } catch (err) {
    console.error(`Error serving meta for ${userId}:`, (err as Error).message);
    return c.json({ meta: null }, 500);
  }
});

export default meta;
