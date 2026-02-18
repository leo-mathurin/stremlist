import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import api from "./routes/api";
import catalog from "./routes/catalog";
import manifest from "./routes/manifest";
import meta from "./routes/meta";

const app = new Hono();

app.use("*", cors({ origin: "*" }));
app.use("*", logger());

app.route("/api", api);
app.route("", manifest);
app.route("", catalog);
app.route("", meta);

// Stremio sends users here — redirect to frontend
app.get("/:userId/configure", (c) => {
  const userId = c.req.param("userId");
  const frontendUrl = process.env.FRONTEND_URL ?? "https://stremlist.com";
  return c.redirect(`${frontendUrl}/configure?userId=${userId}`);
});

app.get("/health", (c) => c.json({ status: "ok" }));

const port = parseInt(process.env.PORT ?? "7001", 10);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Stremlist backend running on http://localhost:${info.port}`);
});

export type { ApiRoutes } from "./routes/api";
