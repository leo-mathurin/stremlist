import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { supabase } from "./lib/supabase";
import { frontendUrl } from "./lib/urls";
import actions from "./routes/actions";
import api from "./routes/api";
import catalog from "./routes/catalog";
import manifest from "./routes/manifest";
import meta from "./routes/meta";
import oauth from "./routes/oauth";
import stream from "./routes/stream";

const app = new Hono();

app.use("*", cors({ origin: "*" }));
app.use("*", logger());

app.route("", api);
app.route("", manifest);
app.route("", catalog);
app.route("", meta);
app.route("", stream);
app.route("", oauth);
app.route("", actions);

// Stremio sends users here: redirect to the configure page.
app.get("/:accountKey/configure", (c) => {
  const url = new URL("/configure", frontendUrl());
  url.searchParams.set("account", c.req.param("accountKey"));
  return c.redirect(url.toString());
});

// Real health check: pings Supabase so uptime monitors reflect the actual
// state of the addon. A static 200 here would report "up" even when the
// database is down (e.g. usage limit exceeded) and the addon is dead.
app.get("/health", async (c) => {
  const { error } = await supabase
    .from("accounts")
    .select("id", { count: "exact", head: true })
    .limit(1);

  if (error) {
    console.error("Health check failed (Supabase unreachable):", error.message);
    return c.json({ status: "error", database: "down" }, 503);
  }

  return c.json({ status: "ok", database: "up" });
});

export default app;
