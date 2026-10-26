import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import middleware from "../middleware";
import { pageHtml } from "./ai-pages";
import { SITE, absoluteUrl, structuredData } from "../src/content/site";
import { VERSIONS } from "../src/content/changelog";
import { LEGAL_SECTIONS } from "../src/content/terms";
import { FEATURES, STEPS, TROUBLESHOOTING } from "../src/content/home";
import {
  aiRequestPath,
  handleAiRequest,
  prefersMarkdown,
} from "../src/lib/md/http";
import { sitemap } from "../src/lib/md/discovery";
import {
  listMarkdownRoutes,
  markdownPath,
  PASSTHROUGH_MARKDOWN_ROUTES,
  SKIPPED_HTML_ROUTES,
} from "../src/lib/md/registry";

const cases: [string | null, boolean][] = [
  [null, false],
  ["", false],
  ["*/*", false],
  ["text/*", false],
  ["text/html", false],
  ["text/markdown", true],
  ["text/html,text/markdown", false],
  ["text/markdown;q=0.5,text/html;q=0.9", false],
  ["text/html;q=0.5,text/markdown;q=0.9", true],
  ["text/html;q=0.5,text/markdown;q=0.5", false],
  ["text/markdown;q=0", false],
  ["text/markdown;q=1.5", false],
  ["text/markdown;q=broken,text/html;q=0.1", false],
  ["TEXT/MARKDOWN;Q=0.9, text/html;q=0.5", true],
  ["text/markdown;q=0.5,*/*;q=1", false],
  ["text/markdown,*/*;q=0.1", true],
  ["text/html;q=0,text/markdown;q=0.5,*/*;q=1", true],
  ["text/markdown;q=0.4,text/*;q=0.8", false],
  ["text/markdown;q=0.9,text/markdown;q=0.1,text/html;q=0.5", true],
];

for (const [accept, expected] of cases) {
  test(`Accept ${accept ?? "(missing)"} ${expected ? "selects Markdown" : "keeps HTML"}`, () => {
    assert.equal(prefersMarkdown(accept), expected);
  });
}

test("every React HTML route is registered or has an explicit exclusion reason", async () => {
  const app = await readFile(
    new URL("../src/App.tsx", import.meta.url),
    "utf8",
  );
  const routes = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.equal(
    routes.length,
    [...app.matchAll(/<Route\s/g)].length,
    "Route declarations changed; update this route inventory check.",
  );
  assert.ok(routes.length > 0);
  const publicPaths = listMarkdownRoutes().map((page) => page.path);
  for (const path of routes) {
    assert.ok(
      publicPaths.includes(path) || SKIPPED_HTML_ROUTES[path],
      `Missing Markdown renderer or exclusion for ${path}`,
    );
  }
  for (const path of publicPaths)
    assert.ok(
      routes.includes(path),
      `Markdown exposes a route with no HTML page: ${path}`,
    );
  for (const [path, reason] of Object.entries(SKIPPED_HTML_ROUTES)) {
    assert.ok(routes.includes(path), `Obsolete route exclusion: ${path}`);
    assert.ok(reason.length > 0);
    assert.ok(!publicPaths.includes(path));
  }
  const files = await readdir(new URL("../public/", import.meta.url), {
    recursive: true,
  });
  for (const file of files.filter((file) => file.endsWith(".md"))) {
    assert.ok(
      PASSTHROUGH_MARKDOWN_ROUTES.includes(`/${file}`),
      `Real Markdown asset must bypass suffix handling: ${file}`,
    );
  }
});

test("middleware rewrites only explicit Markdown and allowlisted negotiated pages", () => {
  for (const page of listMarkdownRoutes()) {
    for (const path of [markdownPath(page.path), `/api/md${page.path}`]) {
      const rewritten = middleware(
        new Request(`https://preview.example${path}`),
      );
      const target = new URL(
        rewritten.headers.get("x-middleware-rewrite") ?? "",
      );
      assert.equal(target.origin, "https://preview.example");
      assert.equal(target.pathname, "/api/ai");
      assert.equal(target.searchParams.get("source"), path);
    }
    const request = new Request(`https://preview.example${page.path}`, {
      headers: { Accept: "text/markdown" },
    });
    assert.equal(aiRequestPath(request), markdownPath(page.path));
    const html = middleware(new Request(`https://preview.example${page.path}`));
    assert.equal(
      new URL(html.headers.get("x-middleware-rewrite") ?? "").pathname,
      page.path === "/" ? "/index.html" : `${page.path}/index.html`,
    );
    assert.equal(html.headers.get("vary"), "Accept");
    assert.match(html.headers.get("link") ?? "", /llms-full\.txt/);
  }
  const privateRequest = middleware(
    new Request("https://preview.example/index.md?account=secret"),
  );
  const privateTarget = new URL(
    privateRequest.headers.get("x-middleware-rewrite") ?? "",
  );
  assert.equal(privateTarget.searchParams.get("private"), "1");
  assert.ok(!privateTarget.href.includes("secret"));
  for (const path of [
    "/configure?account=secret",
    "/?userId=ur12345678",
    "/api/accounts",
    "/api/manifest.json",
    "/api/ai",
    "/assets/source.md",
    "/.well-known/guide.md",
    "/_next/file.md",
    "/unknown",
    "/%invalid.md",
  ]) {
    assert.equal(
      aiRequestPath(
        new Request(`https://preview.example${path}`, {
          headers: { Accept: "text/markdown" },
        }),
      ),
      null,
      path,
    );
  }
});

test("public HTTP responses share real content and keep private data out", async (t) => {
  let statsRequests = 0;
  const backend = createServer((req, res) => {
    if (req.url !== "/stats") {
      res.writeHead(404).end();
      return;
    }
    statsRequests++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ activeUsers: 1234 }));
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        backend.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = backend.address();
  assert.ok(address && typeof address === "object");
  const backendUrl = `http://127.0.0.1:${address.port}`;
  const fetchPage = (path: string, init?: RequestInit) =>
    handleAiRequest(
      new Request(`http://frontend.example${path}`, init),
      backendUrl,
    );

  for (const page of listMarkdownRoutes()) {
    const suffix = await fetchPage(markdownPath(page.path));
    const body = await suffix.text();
    assert.equal(suffix.status, 200);
    assert.equal(
      suffix.headers.get("content-type"),
      "text/markdown; charset=utf-8",
    );
    assert.equal(
      suffix.headers.get("x-markdown-tokens"),
      String(Math.ceil(body.length / 4)),
    );
    assert.equal(suffix.headers.get("x-robots-tag"), "noindex, follow");
    assert.equal(
      suffix.headers.get("content-location"),
      absoluteUrl(page.path),
    );
    if (page.path !== "/") assert.ok(suffix.headers.get("last-modified"));
    assert.match(suffix.headers.get("link") ?? "", /rel="canonical"/);
    assert.equal(suffix.headers.get("access-control-allow-origin"), "*");
    assert.equal(suffix.headers.get("vary"), "Accept");
    assert.match(body, /^# /);
    assert.ok(!body.includes("<html"));
    for (const match of body.matchAll(/\]\(([^)]+)\)/g))
      assert.ok(/^(https:\/\/|mailto:)/.test(match[1]), match[1]);
    const direct = await fetchPage(`/api/md${page.path}`);
    assert.equal(await direct.text(), body);
    const negotiated = await fetchPage(page.path, {
      headers: { Accept: "text/html;q=0.5,text/markdown;q=0.9" },
    });
    assert.equal(await negotiated.text(), body);
    const head = await fetchPage(markdownPath(page.path), { method: "HEAD" });
    assert.deepEqual([...head.headers], [...suffix.headers]);
    assert.equal(await head.text(), "");
    const options = await fetchPage(markdownPath(page.path), {
      method: "OPTIONS",
    });
    assert.equal(options.status, 204);
    assert.equal(await options.text(), "");
    assert.equal(
      options.headers.get("access-control-allow-methods"),
      "GET, HEAD, OPTIONS",
    );
  }
  const home = await (await fetchPage("/index.md")).text();
  assert.match(home, /1,234 people use Stremlist/);
  assert.match(home, /Letterboxd \| Soon/);
  for (const [title, body] of [...FEATURES, ...STEPS, ...TROUBLESHOOTING]) {
    assert.ok(home.includes(title));
    assert.ok(home.includes(body));
  }
  const legal = await (await fetchPage("/terms.md")).text();
  for (const section of LEGAL_SECTIONS)
    for (const clause of section.clauses)
      assert.ok(legal.includes(clause.title));
  const changes = await (await fetchPage("/changelog.md")).text();
  for (const version of VERSIONS) {
    assert.ok(changes.includes(version.version));
    for (const change of version.changes)
      assert.ok(changes.includes(change.text));
  }
  const countBeforePrivate = statsRequests;
  for (const path of [
    "/does-not-exist.md",
    "/configure.md",
    "/api/md/configure",
    "/api/md/admin",
    "/api/md/sl_private/actions/rating/rate/movie/tt1234567",
    "/api/md/oauth/trakt/callback",
    "/index.md?account=sl_private",
    "/api/ai?source=/configure",
    "/api/ai?source=/index.md&private=1",
  ]) {
    const res = await fetchPage(path);
    assert.equal(res.status, 404, path);
    assert.match(res.headers.get("content-type") ?? "", /^text\/markdown/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok(!(await res.text()).includes("sl_private"));
  }
  assert.equal(statsRequests, countBeforePrivate);
  const post = await fetchPage("/terms.md", { method: "POST" });
  assert.equal(post.status, 405);

  const catalogResponse = await fetchPage("/api/md/_catalog");
  const entries: unknown = await catalogResponse.json();
  assert.ok(Array.isArray(entries));
  assert.equal(entries.length, 3);
  assert.ok(!JSON.stringify(entries).includes("configure"));
  const index = await (await fetchPage("/llms.txt")).text();
  for (const page of listMarkdownRoutes())
    assert.ok(index.includes(absoluteUrl(markdownPath(page.path))));
  const full = await (await fetchPage("/llms-full.txt")).text();
  for (const page of listMarkdownRoutes())
    assert.ok(full.includes(`<!-- source: ${absoluteUrl(page.path)} -->`));
  assert.ok(full.length < 500_000);
  const countBeforeCached = statsRequests;
  assert.equal(await (await fetchPage("/llms-full.txt")).text(), full);
  assert.equal(statsRequests, countBeforeCached);
  const policy = await (await fetchPage("/ai.txt")).text();
  assert.ok(
    policy.includes(SITE.name) &&
      policy.includes(SITE.url) &&
      policy.includes(SITE.contact) &&
      policy.includes(SITE.description),
  );
  assert.match(policy, /Use public content for AI model training/);
  const robots = await (await fetchPage("/robots.txt")).text();
  for (const bot of [
    "*",
    "OAI-SearchBot",
    "ChatGPT-User",
    "Claude-SearchBot",
    "Claude-User",
    "PerplexityBot",
    "Perplexity-User",
    "GPTBot",
    "ClaudeBot",
    "Google-Extended",
    "Applebot-Extended",
    "CCBot",
    "Bytespider",
  ]) {
    const group = robots
      .split("\n\n")
      .find((group) => group.startsWith(`User-agent: ${bot}\n`));
    assert.ok(group, bot);
    assert.match(group, /Allow: \/\n/);
    assert.match(group, /Allow: \/api\/md\//);
    assert.match(group, /Disallow: \/configure/);
    assert.ok(!/^Disallow: \/$/m.test(group));
  }
  assert.match(robots, /Sitemap: https:\/\/stremlist.com\/sitemap.xml/);
  const unavailable = await handleAiRequest(
    new Request("http://frontend.example/index.md"),
    `${backendUrl}/missing`,
  );
  assert.equal(unavailable.status, 200);
  assert.ok(!(await unavailable.text()).includes("people use Stremlist"));
});

test("initial HTML has page-specific discovery tags and consistent homepage identity", async () => {
  const template = await readFile(
    new URL("../index.html", import.meta.url),
    "utf8",
  );
  for (const page of listMarkdownRoutes()) {
    const html = pageHtml(template, page.path);
    assert.ok(!html.includes("__SITE_"));
    assert.ok(html.includes(`href="${absoluteUrl(markdownPath(page.path))}"`));
    assert.match(html, /<meta name="ai-summary" content="[^"]+"/);
    assert.ok(
      html.includes(`rel="canonical" href="${absoluteUrl(page.path)}"`),
    );
    assert.equal((html.match(/type="text\/markdown"/g) ?? []).length, 1);
    if (page.path === "/") {
      const json = html.match(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
      )?.[1];
      assert.ok(json);
      assert.deepEqual(JSON.parse(json), structuredData());
    } else assert.ok(!html.includes('"@type":"Organization"'));
  }
  for (const path of ["/configure", "/missing"]) {
    const html = pageHtml(template, path);
    assert.match(html, /noindex, nofollow/);
    assert.ok(!html.includes('type="text/markdown"'));
    assert.ok(!html.includes('name="ai-summary"'));
  }
  assert.ok(!sitemap().includes(".md"));
  assert.ok(!sitemap().includes("configure"));
});
