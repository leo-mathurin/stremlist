import { hc } from "hono/client";
import type { ApiRoutes } from "./routes/api.js";

// Pre-calculate the client type at compile time so tsserver doesn't
// need to instantiate all generic type arguments on every IDE access.
export type Client = ReturnType<typeof hc<ApiRoutes>>;

export const hcWithType = (...args: Parameters<typeof hc>): Client =>
  hc<ApiRoutes>(...args);
