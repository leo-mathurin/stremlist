import { withRelatedProject } from "@vercel/related-projects";
import type { Context } from "hono";

/** The configure site, for redirects back from the backend. */
export function frontendUrl(): string {
  return withRelatedProject({
    projectName: "stremlist-frontend",
    defaultHost: process.env.FRONTEND_URL ?? "http://localhost:5173",
  });
}

/** Public origin of this backend (OAuth callbacks, Action links). */
export function backendOrigin(c: Context): string {
  return (process.env.BACKEND_PUBLIC_URL ?? new URL(c.req.url).origin).replace(
    /\/+$/,
    "",
  );
}
