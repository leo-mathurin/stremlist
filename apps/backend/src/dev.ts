import { serve } from "@hono/node-server";
import app from "./index.js";

const port = parseInt(process.env.PORT ?? "7001", 10);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Stremlist backend running on http://localhost:${info.port}`);
});
