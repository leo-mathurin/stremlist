import { absoluteUrl } from "../../content/site";
import { publicUserCount } from "../public-stats";
import {
  aiPolicy,
  catalog,
  DISCOVERY_PATHS,
  discoveryLinks,
  fullContent,
  llms,
  robots,
  sitemap,
} from "./discovery";
import {
  getMarkdownPage,
  markdownPath,
  PASSTHROUGH_MARKDOWN_ROUTES,
  renderMarkdownPage,
} from "./registry";

export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  const ranges = accept
    .toLowerCase()
    .split(",")
    .map((range) => {
      const [type, ...parameters] = range
        .trim()
        .split(";")
        .map((part) => part.trim());
      const q =
        parameters.find((part) => part.startsWith("q="))?.slice(2) ?? "1";
      return {
        type,
        q: /^(0(\.\d{0,3})?|1(\.0{0,3})?)$/.test(q) ? Number(q) : 0,
      };
    });
  const quality = (type: string) => {
    const matches = ranges.filter((range) => range.type === type);
    return matches.length
      ? Math.max(...matches.map((range) => range.q))
      : undefined;
  };
  const markdown = quality("text/markdown") ?? 0;
  const html = quality("text/html") ?? quality("text/*") ?? quality("*/*") ?? 0;
  return markdown > 0 && markdown > html;
}

function pathname(url: URL): string | null {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

export function aiRequestPath(request: Request): string | null {
  const url = new URL(request.url);
  const path = pathname(url);
  if (!path || PASSTHROUGH_MARKDOWN_ROUTES.includes(path)) return null;
  if (DISCOVERY_PATHS.includes(path)) return path;
  if (path === "/api/md" || path.startsWith("/api/md/")) return path;
  if (/^\/(?:api|assets|providers|_next|\.well-known)(?:\/|$)/.test(path))
    return null;
  if (path.endsWith(".md")) return path;
  if (url.searchParams.has("userId") || url.searchParams.has("account"))
    return null;
  const page = getMarkdownPage(path);
  return page && prefersMarkdown(request.headers.get("accept"))
    ? markdownPath(page.path)
    : null;
}

export function htmlHeaders(path: string): Record<string, string> {
  return getMarkdownPage(path)
    ? { Link: discoveryLinks(), Vary: "Accept" }
    : { Link: discoveryLinks(), "X-Robots-Tag": "noindex, nofollow" };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type",
  "Access-Control-Expose-Headers":
    "X-Markdown-Tokens, Content-Location, Link, Last-Modified",
};

let fullSnapshot:
  | { backendUrl: string; expires: number; body: Promise<string> }
  | undefined;

export async function handleAiRequest(
  request: Request,
  backendUrl: string,
): Promise<Response> {
  const url = new URL(request.url);
  // The Vercel middleware passes only a public path, never Account query parameters.
  const source =
    url.pathname === "/api/ai"
      ? url.searchParams.get("source")
      : aiRequestPath(request);
  const headers = new Headers({
    ...CORS_HEADERS,
    Link: discoveryLinks(),
    Vary: "Accept",
    "Content-Type": "text/markdown; charset=utf-8",
    "X-Robots-Tag": "noindex, follow",
    "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
  });
  const response = (body: string, status = 200) => {
    if (headers.get("Content-Type")?.startsWith("text/markdown"))
      headers.set("X-Markdown-Tokens", String(Math.ceil(body.length / 4)));
    return new Response(
      request.method === "HEAD" || status === 204 ? null : body,
      { status, headers },
    );
  };
  if (request.method === "OPTIONS") return response("", 204);
  if (request.method !== "GET" && request.method !== "HEAD") {
    headers.set("Allow", "GET, HEAD, OPTIONS");
    headers.set("Cache-Control", "no-store");
    return response("# Method not allowed\n", 405);
  }
  if (source && DISCOVERY_PATHS.includes(source)) {
    headers.set(
      "Content-Type",
      source === "/api/md/_catalog"
        ? "application/json; charset=utf-8"
        : source === "/sitemap.xml"
          ? "application/xml; charset=utf-8"
          : "text/plain; charset=utf-8",
    );
    if (source === "/api/md/_catalog")
      return response(JSON.stringify(catalog()));
    if (source === "/robots.txt") return response(robots());
    if (source === "/sitemap.xml") return response(sitemap());
    if (source === "/ai.txt") return response(aiPolicy());
    headers.set(
      "Cache-Control",
      "public, s-maxage=86400, stale-while-revalidate=604800",
    );
    if (source === "/llms.txt") return response(llms());
    if (
      !fullSnapshot ||
      fullSnapshot.backendUrl !== backendUrl ||
      fullSnapshot.expires < Date.now()
    ) {
      fullSnapshot = {
        backendUrl,
        expires: Date.now() + 86_400_000,
        body: publicUserCount({
          backendUrl,
          signal: AbortSignal.timeout(2000),
        }).then(fullContent),
      };
    }
    return response(await fullSnapshot.body);
  }
  const path =
    source === "/index.md" || source === "/api/md" || source === "/api/md/"
      ? "/"
      : source?.startsWith("/api/md/")
        ? source.slice("/api/md".length)
        : source?.endsWith(".md")
          ? source.slice(0, -3)
          : undefined;
  const page = path ? getMarkdownPage(path) : undefined;
  if (
    !page ||
    url.searchParams.has("account") ||
    url.searchParams.has("userId") ||
    url.searchParams.has("private")
  ) {
    headers.set("Cache-Control", "no-store");
    return response(
      "# Page not found\n\nThis address has no public Markdown page.\n",
      404,
    );
  }
  const canonical = absoluteUrl(page.path);
  headers.set("Content-Location", canonical);
  headers.set("Link", `${discoveryLinks()}, <${canonical}>; rel="canonical"`);
  if (page.path !== "/")
    headers.set(
      "Last-Modified",
      new Date(`${page.updated}T00:00:00Z`).toUTCString(),
    );
  const userCount =
    page.path === "/"
      ? await publicUserCount({ backendUrl, signal: AbortSignal.timeout(2000) })
      : null;
  return response(renderMarkdownPage(page, { userCount }));
}
