import { withRelatedProject } from "@vercel/related-projects";
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

app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
export type { ApiRoutes } from "./routes/api";
