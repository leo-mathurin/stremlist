import { Hono } from "hono";
import { resolveAccountKey } from "../services/accounts";
import { findMetaInAccountCache } from "../services/lists";

const meta = new Hono();

// Keep cache-only movie metadata for titles missing from Cinemeta. Catalog
// previews lack episodes, so series must resolve through another meta addon.
meta.get("/:accountKey/meta/:type/:id.json", async (c) => {
  const type = c.req.param("type");

  // Clients can request the catalog source directly or retain an old manifest.
  if (type === "series") return c.json({ meta: null });

  const id = (c.req.param("id") ?? c.req.param("id.json")).replace(
    /\.json$/u,
    "",
  );

  const access = await resolveAccountKey(c.req.param("accountKey")).catch(
    () => null,
  );
  if (!access) return c.json({ meta: null });
  const item = await findMetaInAccountCache(access, type, id);
  return c.json({ meta: item });
});

export default meta;
