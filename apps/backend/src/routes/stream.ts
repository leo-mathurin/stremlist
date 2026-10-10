import { Hono } from "hono";
import { backendOrigin } from "../lib/urls";
import { resolveAccountKey } from "../services/accounts";
import { buildActionStreams, parseStreamId } from "../services/actions";

const stream = new Hono();

/**
 * Action entries for a Title (ADR 0003). Only private Addon URLs with Actions
 * turned on get entries; every entry opens a Stremlist page (externalUrl), so
 * the Stremio player never loads.
 */
stream.get("/:accountKey/stream/:type/:id.json", async (c) => {
  // Labels reflect membership, which changes after each Action.
  c.header("Cache-Control", "no-store");
  const empty = { streams: [], cacheMaxAge: 0 };
  const type = c.req.param("type");
  const id = (c.req.param("id") ?? c.req.param("id.json")).replace(
    /\.json$/u,
    "",
  );
  if (type !== "movie" && type !== "series") return c.json(empty);

  const target = parseStreamId(type, decodeURIComponent(id));
  if (!target) return c.json(empty);

  try {
    const access = await resolveAccountKey(c.req.param("accountKey"));
    if (access?.via !== "private") return c.json(empty);
    const origin = backendOrigin(c);
    const accountId = access.account.id;
    const streams = await buildActionStreams(
      access.account,
      target,
      (kind, op) =>
        `${origin}/${accountId}/actions/${kind}/${op}/${type}/${encodeURIComponent(id)}`,
    );
    return c.json({ streams, cacheMaxAge: 0 });
  } catch (error) {
    console.error(
      "Failed to build action streams:",
      error instanceof Error ? error.message : error,
    );
    return c.json(empty);
  }
});

export default stream;
