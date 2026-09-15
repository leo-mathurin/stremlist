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
