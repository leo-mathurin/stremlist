import { Hono } from "hono";
import { findMetaInUserCache } from "../services/watchlist";

const meta = new Hono();

// Stremlist serves meta ONLY from cache: it never scrapes IMDb, never throws,
// and on any miss returns { meta: null } so Stremio falls back to Cinemeta. The
// `meta` resource stays advertised in BASE_MANIFEST because some Stremlist-only
// movies have no Cinemeta entry and would otherwise lose their detail/stream
// page (dropping it is a regression). Removing the old per-request watchlist
// fan-out — which re-scraped IMDb on stale caches and 500'd on failure — is what
// fixes the prod 500/504 storm on /meta.
meta.get("/:userId/meta/:type/:id.json", async (c) => {
  const userId = c.req.param("userId");
  const type = c.req.param("type");
  const id = (c.req.param("id") ?? c.req.param("id.json")).replace(
    /\.json$/u,
    "",
  );

  const item = await findMetaInUserCache(userId, type, id);
  return c.json({ meta: item });
});

export default meta;
