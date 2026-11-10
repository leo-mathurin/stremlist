import { Hono } from "hono";
import accounts from "./api/accounts";
import connections from "./api/connections";
import lists from "./api/lists";
import monitor from "./api/monitor";
import newsletter from "./api/newsletter";
import stremio from "./api/stremio";

/**
 * The JSON API of the configure page. Each part is a chained sub-app, so
 * `ApiRoutes` keeps the type of every route for the typed client.
 */
const api = new Hono()
  .route("", accounts)
  .route("", lists)
  .route("", connections)
  .route("", newsletter)
  .route("", monitor)
  .route("", stremio);

export default api;
export type ApiRoutes = typeof api;
