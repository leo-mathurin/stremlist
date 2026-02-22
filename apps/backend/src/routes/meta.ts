import { Hono } from "hono";
import { getUserRpdbApiKey, getUserWatchlists } from "../services/user";
import { getWatchlistByConfig } from "../services/watchlist";

const meta = new Hono();

meta.get("/:userId/meta/:type/:id.json", async (c) => {
  const userId = c.req.param("userId");
  const type = c.req.param("type");
  const id = (c.req.param("id") ?? c.req.param("id.json")).replace(
    /\.json$/u,
    "",
  );

  try {
    const [watchlists, rpdbApiKey] = await Promise.all([
      getUserWatchlists(userId),
      getUserRpdbApiKey(userId),
    ]);
    const results = await Promise.all(
      watchlists.map((watchlist) =>
        getWatchlistByConfig({
          ownerUserId: userId,
          watchlistId: watchlist.id,
          imdbUserId: watchlist.imdbUserId,
          sortOption: watchlist.sortOption,
          rpdbApiKey,
        }),
      ),
    );

    let item = null;
    for (const data of results) {
      const found = data.metas.find((m) => m.id === id && m.type === type);
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

    return c.json({ meta: item });
  } catch (err) {
    console.error(`Error serving meta for ${userId}:`, (err as Error).message);
    return c.json({ meta: null }, 500);
  }
});

export default meta;
