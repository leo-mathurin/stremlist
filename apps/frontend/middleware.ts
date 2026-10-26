import { next, rewrite } from "@vercel/functions";
import { aiRequestPath, htmlHeaders } from "./src/lib/md/http";
import { getMarkdownPage } from "./src/lib/md/registry";

export const config = {
  runtime: "nodejs",
  matcher: [
    "/((?!assets/|providers/|_next/|\\.well-known/|@|src/|node_modules/).*)",
  ],
};

export default function middleware(request: Request): Response {
  const url = new URL(request.url);
  const source = aiRequestPath(request);
  if (source !== null) {
    const destination = new URL("/api/ai", request.url);
    destination.searchParams.set("source", source);
    if (url.searchParams.has("account") || url.searchParams.has("userId"))
      destination.searchParams.set("private", "1");
    return rewrite(destination);
  }
  const page = getMarkdownPage(url.pathname);
  const headers = htmlHeaders(url.pathname);
  if (url.searchParams.has("account") || url.searchParams.has("userId"))
    headers["X-Robots-Tag"] = "noindex, nofollow";
  if (page)
    return rewrite(
      new URL(
        page.path === "/" ? "/index.html" : `${page.path}/index.html`,
        request.url,
      ),
      { headers },
    );
  return next({ headers });
}
