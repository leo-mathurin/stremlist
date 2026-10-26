import type { Plugin } from "vite";
import {
  SITE,
  CONFIGURE_SEO,
  absoluteUrl,
  structuredData,
} from "../src/content/site";
import {
  aiRequestPath,
  handleAiRequest,
  htmlHeaders,
} from "../src/lib/md/http";
import {
  getMarkdownPage,
  listMarkdownRoutes,
  markdownPath,
} from "../src/lib/md/registry";

function attribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function pageHtml(html: string, path: string): string {
  const page = getMarkdownPage(path);
  const title =
    page?.seoTitle ??
    (path === "/configure"
      ? CONFIGURE_SEO.title
      : `Page not found - ${SITE.name}`);
  const description =
    page?.description ??
    (path === "/configure"
      ? CONFIGURE_SEO.description
      : "The requested Stremlist page could not be found.");
  const canonical = absoluteUrl(page?.path ?? "/");
  let result = html
    .replaceAll("__SITE_TITLE__", attribute(SITE.title))
    .replaceAll("__SITE_DESCRIPTION__", attribute(SITE.description))
    .replaceAll("__SITE_URL__", SITE.url)
    .replaceAll("__SITE_IMAGE__", absoluteUrl(SITE.image))
    .replaceAll("__SITE_NAME__", attribute(SITE.name))
    .replace(/<title>[^<]*<\/title>/, `<title>${attribute(title)}</title>`)
    .replace(
      /<meta\s+name="description"\s+content="[^"]*"\s*\/?\s*>/,
      `<meta name="description" content="${attribute(description)}" />`,
    )
    .replace(
      /<meta\s+name="robots"\s+content="[^"]*"\s*\/?\s*>/,
      `<meta name="robots" content="${page ? "index, follow" : "noindex, nofollow"}" />`,
    )
    .replace(
      /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?\s*>/,
      page ? `<link rel="canonical" href="${canonical}" />` : "",
    )
    .replace(
      /<meta\s+property="((?:og|twitter):(?:title|description|url|image))"\s+content="[^"]*"\s*\/?\s*>/g,
      (_tag: string, key: string) => {
        const field = key.split(":")[1];
        const value =
          field === "title"
            ? title
            : field === "description"
              ? description
              : field === "image"
                ? absoluteUrl(SITE.image)
                : canonical;
        return `<meta property="${key}" content="${attribute(value)}" />`;
      },
    )
    .replace(/\s*<meta\s+name="ai-summary"[^>]*>/g, "")
    .replace(/\s*<link\s+rel="alternate"\s+type="text\/markdown"[^>]*>/g, "")
    .replace(
      /\s*<script\s+type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/g,
      "",
    );
  const tags = page
    ? [
        `<meta name="ai-summary" content="${attribute(page.summary)}" />`,
        `<link rel="alternate" type="text/markdown" href="${absoluteUrl(markdownPath(page.path))}" />`,
        ...(page.path === "/"
          ? [
              `<script type="application/ld+json">${JSON.stringify(structuredData()).replace(/</g, "\\u003c")}</script>`,
            ]
          : []),
      ].join("\n    ")
    : "";
  result = result.replace("</head>", `    ${tags}\n  </head>`);
  return result;
}

export function aiPages(backendUrl: string): Plugin {
  const configure = (
    server: Pick<import("vite").ViteDevServer, "middlewares">,
    built = false,
  ) => {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (value) headers.set(key, value.join(", "));
      }
      const request = new Request(url, { method: req.method, headers });
      if (aiRequestPath(request) !== null) {
        try {
          const response = await handleAiRequest(request, backendUrl);
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          next(error);
        }
        return;
      }
      for (const [key, value] of Object.entries(htmlHeaders(url.pathname)))
        res.setHeader(key, value);
      if (built) {
        const page = getMarkdownPage(url.pathname);
        if (page)
          req.url =
            page.path === "/" ? "/index.html" : `${page.path}/index.html`;
        else if (url.pathname === "/configure")
          req.url = "/configure/index.html";
        else if (!url.pathname.split("/").at(-1)?.includes("."))
          req.url = "/404.html";
      }
      next();
    });
  };
  return {
    name: "ai-readable-pages",
    configureServer: configure,
    configurePreviewServer(server) {
      configure(server, true);
    },
    transformIndexHtml(html, context) {
      return pageHtml(
        html,
        new URL(context.originalUrl ?? "/", "http://localhost").pathname,
      );
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const index = bundle["index.html"];
        if (index?.type !== "asset" || typeof index.source !== "string")
          throw new Error("Missing frontend index.html");
        const template = index.source;
        index.source = pageHtml(template, "/");
        for (const page of listMarkdownRoutes().filter(
          (page) => page.path !== "/",
        )) {
          this.emitFile({
            type: "asset",
            fileName: `${page.path.slice(1)}/index.html`,
            source: pageHtml(template, page.path),
          });
        }
        this.emitFile({
          type: "asset",
          fileName: "404.html",
          source: pageHtml(template, "/404"),
        });
        this.emitFile({
          type: "asset",
          fileName: "configure/index.html",
          source: pageHtml(template, "/configure"),
        });
      },
    },
  };
}
