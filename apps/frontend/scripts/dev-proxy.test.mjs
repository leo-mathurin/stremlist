import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { afterEach, beforeEach, test } from "node:test";
import { createServer, loadConfigFromFile } from "vite";

const keys = [
  "PORTLESS_URL",
  "VITE_BACKEND_URL",
  "DEV_BACKEND_URL",
  "VERCEL_RELATED_PROJECTS",
];
let original;

beforeEach(() => {
  original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = "";
});

afterEach(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

test("Portless proxies API paths and keeps Stremio configure redirects on the frontend", async (t) => {
  const upstream = createHttpServer((request, response) => {
    if (request.url === "/ur00000001/configure") {
      response.writeHead(302, {
        Location: "http://localhost:5173/configure?userId=ur00000001",
      });
      response.end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({ path: request.url, host: request.headers.host }),
    );
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const target = `http://127.0.0.1:${upstream.address().port}`;
  process.env.PORTLESS_URL = "https://test.stremlist.localhost";
  process.env.VITE_BACKEND_URL = "http://stale-host.invalid:7001";
  process.env.DEV_BACKEND_URL = target;

  const vite = await createServer({
    mode: "test",
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, watch: null },
  });
  t.after(() => vite.close());
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  assert.equal(
    vite.config.define["import.meta.env.VITE_BACKEND_URL"],
    '"/api"',
  );
  const response = await fetch(`${origin}/api/manifest.json?probe=1`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    path: "/manifest.json?probe=1",
    host: new URL(target).host,
  });
  const redirect = await fetch(`${origin}/api/ur00000001/configure`, {
    redirect: "manual",
  });
  assert.equal(redirect.status, 302);
  assert.equal(
    redirect.headers.get("location"),
    "/configure?userId=ur00000001",
  );
});

test("direct development defaults to the same-origin API proxy", async () => {
  const { config } = await loadConfigFromFile({
    command: "serve",
    mode: "test",
  });
  assert.equal(config.define["import.meta.env.VITE_BACKEND_URL"], '"/api"');
  assert.equal(config.server.proxy["/api"].target, "http://localhost:7001");
});

test("explicit API URLs are preserved for the E2E harness and production builds", async () => {
  process.env.VITE_BACKEND_URL = "http://127.0.0.1:7301";
  for (const command of ["serve", "build"]) {
    const { config } = await loadConfigFromFile({ command, mode: "test" });
    assert.equal(
      config.define["import.meta.env.VITE_BACKEND_URL"],
      '"http://127.0.0.1:7301"',
    );
    assert.equal(config.server.proxy, undefined);
  }
});

test("public Markdown, negotiation and discovery work through the real Vite server", async (t) => {
  const upstream = createHttpServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ activeUsers: 1234 }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  process.env.DEV_BACKEND_URL = `http://127.0.0.1:${upstream.address().port}`;
  const vite = await createServer({
    mode: "test",
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, watch: null },
  });
  t.after(() => vite.close());
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  for (const path of ["/", "/terms", "/changelog"]) {
    for (const accept of [
      undefined,
      "*/*",
      "text/html",
      "text/markdown;q=0.5,text/html;q=0.9",
    ]) {
      const response = await fetch(`${origin}${path}`, {
        headers: accept ? { Accept: accept } : {},
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /^text\/html/);
      assert.match(response.headers.get("link"), /rel="describedby"/);
      assert.match(response.headers.get("vary"), /Accept/);
      const html = await response.text();
      assert.match(html, /<meta name="ai-summary" content="[^"]+"/);
      assert.ok(
        html.includes(
          `href="https://stremlist.com${path === "/" ? "/index.md" : `${path}.md`}"`,
        ),
      );
      assert.ok(!html.includes("__SITE_"));
    }
    const mdPath = path === "/" ? "/index.md" : `${path}.md`;
    const md = await fetch(`${origin}${mdPath}`);
    assert.equal(md.status, 200);
    assert.equal(
      md.headers.get("content-type"),
      "text/markdown; charset=utf-8",
    );
    const body = await md.text();
    const negotiated = await fetch(`${origin}${path}`, {
      headers: { Accept: "text/markdown" },
    });
    assert.equal(await negotiated.text(), body);
    const direct = await fetch(`${origin}/api/md${path}`);
    assert.equal(await direct.text(), body);
    const head = await fetch(`${origin}${mdPath}`, { method: "HEAD" });
    assert.equal(
      head.headers.get("x-markdown-tokens"),
      md.headers.get("x-markdown-tokens"),
    );
    assert.equal(await head.text(), "");
  }
  const root = await (await fetch(`${origin}/`)).text();
  assert.match(root, /application\/ld\+json/);
  const missing = await fetch(`${origin}/missing.md`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get("content-type"), /^text\/markdown/);
  for (const path of [
    "/configure.md",
    "/api/md/configure",
    "/api/md/private/actions/rating/rate/movie/tt1234567",
  ]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type"), /^text\/markdown/);
  }
  const configure = await fetch(`${origin}/configure`);
  assert.match(configure.headers.get("x-robots-tag"), /noindex/);
  const privateHtml = await configure.text();
  assert.ok(!privateHtml.includes('type="text/markdown"'));
  assert.ok(privateHtml.includes("Configure - Stremlist"));
  for (const path of [
    "/llms.txt",
    "/llms-full.txt",
    "/ai.txt",
    "/robots.txt",
  ]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "text/plain; charset=utf-8",
    );
    assert.ok(
      (await response.text()).includes("Stremlist") || path === "/robots.txt",
    );
  }
  const catalog = await fetch(`${origin}/api/md/_catalog`);
  assert.equal((await catalog.json()).length, 3);
  const sitemap = await fetch(`${origin}/sitemap.xml`, {
    headers: { Accept: "text/markdown" },
  });
  assert.equal(
    sitemap.headers.get("content-type"),
    "application/xml; charset=utf-8",
  );
  assert.ok(!(await sitemap.text()).includes(".md"));
});
