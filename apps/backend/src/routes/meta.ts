import { Hono } from "hono";
import { getUserRpdbApiKey, getUserWatchlists } from "../services/user";
import { getWatchlistByConfig } from "../services/watchlist";

const meta = new Hono();

meta.get("/:userId/meta/:type/:id.json", async (c) => {
  const userId = c.req.param("userId");
  const type = c.req.param("type");
  const id = c.req.param("id");

  try {
    const watchlists = await getUserWatchlists(userId);
    const rpdbApiKey = await getUserRpdbApiKey(userId);

    let item = null;
    for (const watchlist of watchlists) {
      const watchlistData = await getWatchlistByConfig({
        ownerUserId: userId,
        watchlistId: watchlist.id,
        imdbUserId: watchlist.imdbUserId,
        sortOption: watchlist.sortOption,
        rpdbApiKey,
      });
      const found = watchlistData.metas.find((m) => m.id === id && m.type === type);
      if (found) {
        item = found;
        break;
      }
    }

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
