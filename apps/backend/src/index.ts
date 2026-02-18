import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import api from "./routes/api.js";
import catalog from "./routes/catalog.js";
import manifest from "./routes/manifest.js";
import meta from "./routes/meta.js";

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

export default app;
export type { ApiRoutes } from "./routes/api.js";
