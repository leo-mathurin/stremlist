import { Hono } from "hono";
import { findMetaInUserCache } from "../services/watchlist";

const meta = new Hono();

// Keep cache-only movie metadata for titles missing from Cinemeta. Catalog
// previews lack episodes, so series must resolve through another meta addon.
meta.get("/:userId/meta/:type/:id.json", async (c) => {
  const userId = c.req.param("userId");
  const type = c.req.param("type");

  // Clients can request the catalog source directly or retain an old manifest.
  if (type === "series") return c.json({ meta: null });

  const id = (c.req.param("id") ?? c.req.param("id.json")).replace(
    /\.json$/u,
    "",
  );

  const item = await findMetaInUserCache(userId, type, id);
  return c.json({ meta: item });
});

export default meta;
