import { withRelatedProject } from "@vercel/related-projects";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { supabase } from "./lib/supabase";
import api from "./routes/api";
import catalog from "./routes/catalog";
import manifest from "./routes/manifest";
import meta from "./routes/meta";

const app = new Hono();

app.use("*", cors({ origin: "*" }));
app.use("*", logger());

app.route("", api);
app.route("", manifest);
app.route("", catalog);
app.route("", meta);

// Stremio sends users here — redirect to frontend
app.get("/:userId/configure", (c) => {
  const userId = c.req.param("userId");
  const frontendUrl = withRelatedProject({
    projectName: "stremlist-frontend",
    defaultHost: process.env.FRONTEND_URL ?? "http://localhost:5173",
  });
  return c.redirect(`${frontendUrl}/configure?userId=${userId}`);
});

// Real health check: pings Supabase so uptime monitors reflect the actual
// state of the addon. A static 200 here would report "up" even when the
// database is down (e.g. usage limit exceeded) and the addon is dead.
app.get("/health", async (c) => {
  const { error } = await supabase
    .from("users")
    .select("imdb_user_id", { count: "exact", head: true })
    .limit(1);

  if (error) {
    console.error("Health check failed (Supabase unreachable):", error.message);
    return c.json({ status: "error", database: "down" }, 503);
  }

  return c.json({ status: "ok", database: "up" });
});

export default app;
export type { ApiRoutes } from "./routes/api";
