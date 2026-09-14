// Read-only production data with the local metadata route and manifest policy.
// Run from any directory: node docs/qa/series-metadata/preview.mjs [port]
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const backend = new URL("../../../apps/backend/", import.meta.url);
const require = createRequire(new URL("package.json", backend));
const { build } = require("esbuild");
const { serve } = require("@hono/node-server");
const user = "ur195879360";
const upstream = "https://api.stremlist.com";
const port = Number(process.argv[2] ?? 7401);

const cacheDependency = `
export async function findMetaInUserCache(userId, type, id) {
  if (userId !== ${JSON.stringify(user)} || type !== "movie") {
    throw new Error("Preview dependency permits only this user's movie metadata");
  }
  const response = await fetch(${JSON.stringify(upstream)} + "/" + userId + "/meta/movie/" + encodeURIComponent(id) + ".json");
  if (!response.ok) throw new Error("Production movie metadata unavailable");
  return (await response.json()).meta;
}
`;

const source = `
import { Hono } from "hono";
import { cors } from "hono/cors";
import meta from "./src/routes/meta.ts";
import { BASE_MANIFEST } from "../../packages/shared/src/constants.ts";
const app = new Hono();
const prefix = "/" + ${JSON.stringify(user)};
const upstream = ${JSON.stringify(upstream)};
app.use("*", cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] }));
app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Private-Network", "true");
  c.header("Cache-Control", "no-store");
  const parts = c.req.path.split("/");
  const valid = parts[1] === ${JSON.stringify(user)} && (
    (parts.length === 3 && parts[2] === "manifest.json") ||
    (["movie", "series"].includes(parts[3]) && (
      (parts[2] === "catalog" && [5, 6].includes(parts.length) && c.req.path.endsWith(".json")) ||
      (parts[2] === "meta" && parts.length === 5 && /^tt[0-9]+\\.json$/.test(parts[4]))
    ))
  );
  if (!valid || c.req.method !== "GET") return c.json({ error: "Outside preview scope" }, 404);
  console.log(JSON.stringify({ resource: parts[2], type: parts[3], id: parts[4] }));
  await next();
});
app.get(prefix + "/manifest.json", async c => {
  const response = await fetch(upstream + prefix + "/manifest.json");
  if (!response.ok) return c.json({ error: "Production manifest unavailable" }, 502);
  return c.json({ ...await response.json(), resources: BASE_MANIFEST.resources });
});
app.get(prefix + "/catalog/*", async c => {
  const response = await fetch(upstream + c.req.path);
  return new Response(response.body, { status: response.status, headers: {
    "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Private-Network": "true", "Cache-Control": "no-store"
  }});
});
app.route("/", meta);
export default app;
`;

const result = await build({
  stdin: { contents: source, resolveDir: fileURLToPath(backend), loader: "ts" },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  plugins: [
    {
      name: "read-only-production-cache",
      setup(builder) {
        builder.onResolve({ filter: /^\.\.\/services\/watchlist$/ }, () => ({
          path: "cache",
          namespace: "preview",
        }));
        builder.onLoad({ filter: /.*/, namespace: "preview" }, () => ({
          contents: cacheDependency,
          loader: "js",
        }));
      },
    },
  ],
});
const { default: app } = await import(
  "data:text/javascript;base64," +
    Buffer.from(result.outputFiles[0].text).toString("base64")
);
serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => {
  console.log(`Preview: http://127.0.0.1:${port}/${user}/manifest.json`);
});
