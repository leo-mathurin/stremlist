import type { Plugin } from "vite";
import { SITE } from "../src/content/site";
import { headTags } from "../src/lib/seo";
import {
  aiRequestPath,
  handleAiRequest,
  htmlHeaders,
} from "../src/lib/md/http";
import { getMarkdownPage, listMarkdownRoutes } from "../src/lib/md/registry";

function attribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function pageHtml(html: string, path: string): string {
  const page = getMarkdownPage(path);
  const tags = headTags(path)
    .filter(
      (tag) => page || tag.tag !== "link" || tag.attrs.rel !== "canonical",
    )
    .map((tag) => {
      const attrs = Object.entries(tag.attrs)
        .map(([key, value]) => `${key}="${attribute(value)}"`)
        .join(" ");
      const open = `<${tag.tag}${attrs ? ` ${attrs}` : ""} data-page-head="">`;
      return "content" in tag
        ? `${open}${tag.tag === "script" ? tag.content : attribute(tag.content)}</${tag.tag}>`
        : open;
    })
    .join("\n    ");
  return html
    .replaceAll("__SITE_NAME__", attribute(SITE.name))
    .replace(
      /<(title|meta|link|script)\b[^>]*\bdata-page-head(?:="")?[^>]*>(?:[\s\S]*?<\/\1>)?/g,
      "",
    )
    .replace("<!-- page-head -->", `${tags}\n    <!-- page-head -->`);
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
