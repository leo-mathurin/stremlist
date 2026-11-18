/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { SOURCE_LINK_MAX_LENGTH } from "@stremlist/shared/constants";
import { http, HttpResponse } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import app from "../index.js";
import { decryptSecret } from "../lib/crypto";
import { letterboxdProvider } from "../providers/letterboxd";
import {
  OWNER,
  postConfig,
  postJson,
  resetConfigTest,
} from "./helpers/config-api.js";
import { useBackgroundTasks } from "./helpers/background.test-utils.js";
import { readJson } from "./helpers/json.js";
import { useMswServer } from "./helpers/msw.test-utils.js";
import { z } from "zod";

const server = useMswServer();
const background = useBackgroundTasks();

function outsideRequests() {
  const urls: string[] = [];
  const own = new Set(
    [process.env.SUPABASE_URL, process.env.R2_ENDPOINT].map(
      (url) => new URL(url ?? "http://localhost").host,
    ),
  );
  server.events.on("request:start", ({ request }) => {
    if (!own.has(new URL(request.url).host)) urls.push(request.url);
  });
  return urls;
}

function serveLetterboxd(answer: (url: string) => Response | undefined) {
  server.use(
    http.get("https://letterboxd.com/*", ({ request }) => {
      return (
        answer(request.url) ?? new HttpResponse("Not found", { status: 404 })
      );
    }),
    http.get("https://boxd.it/*", ({ request }) => {
      return (
        answer(request.url) ?? new HttpResponse("Not found", { status: 404 })
      );
    }),
    http.post("https://query.wikidata.org/sparql", () =>
      HttpResponse.json({ results: { bindings: [] } }),
    ),
  );
}

const sourceRefBody = z.object({ sourceRef: z.string() }).loose();

const key = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

function page(ids: number[]) {
  return `<html><head><title>A list • Letterboxd</title></head><body><h1>A list</h1><ul class="poster-list -grid">${ids.map((id) => `<li data-postered-identifier='{"uid":"film:${id}"}' data-item-slug="film-${id}" data-item-name="Film ${id} (2000)"></li>`).join("")}</ul></body></html>`;
}

function shareLink(length: number) {
  const user = "u".repeat(40);
  const token = "T0k3n".repeat(4);
  const start = `letterboxd.com/${user}/list/`;
  const end = `/share/${token}/`;
  return `${start}${"a".repeat(length - start.length - end.length)}${end}`;
}

function resolve(input: string, ticket?: string) {
  return postJson("/links/resolve", { input, ticket });
}

beforeEach(() => {
  resetConfigTest();
  server.events.removeAllListeners();
  vi.stubEnv("CONNECTION_ENCRYPTION_KEY", key);
});
afterEach(async () => {
  await background.settle();
  vi.unstubAllEnvs();
});

describe("long Letterboxd share links", () => {
  it("previews and saves the longest share link that the link check accepts", async () => {
    const link = shareLink(SOURCE_LINK_MAX_LENGTH);
    expect(link).toHaveLength(SOURCE_LINK_MAX_LENGTH);
    serveLetterboxd(() => new HttpResponse(page([1])));
    const checked = await readJson(await resolve(link), sourceRefBody);
    expect(checked).toMatchObject({ ok: true, provider: "letterboxd" });
    const { sourceRef } = checked;
    expect(sourceRef.startsWith("share/v1:")).toBe(true);

    const preview = await app.request("/lists/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "letterboxd",
        sourceRef,
        sortOption: "added_at-asc",
      }),
    });
    expect(preview.status).toBe(200);

    const saved = await postConfig(OWNER, {
      lists: [
        { provider: "letterboxd", sourceRef, sortOption: "added_at-asc" },
      ],
    });
    expect(saved.status).toBe(200);
  });

  it("refuses a longer link with a clear reason, before it reads Letterboxd", async () => {
    serveLetterboxd(() => new HttpResponse(page([1])));
    const sent = outsideRequests();
    const res = await resolve(shareLink(SOURCE_LINK_MAX_LENGTH + 1));
    expect(await res.json()).toEqual({ ok: false, reason: "too_long" });
    expect(sent).toEqual([]);
  });
});

describe("renamed Letterboxd members", () => {
  it("follows a 301 to the new username and stores the new reference", async () => {
    serveLetterboxd((url) =>
      url === "https://letterboxd.com/oldname/watchlist/"
        ? new HttpResponse(null, {
            status: 301,
            headers: { location: "/newname/watchlist/" },
          })
        : url === "https://letterboxd.com/newname/watchlist/"
          ? new HttpResponse(page([1]))
          : undefined,
    );
    const res = await resolve("https://letterboxd.com/oldname/watchlist/");
    expect(await res.json()).toMatchObject({
      ok: true,
      sourceRef: "users/newname/watchlist",
      suggestedTitle: "newname's watchlist",
    });
  });

  it("reads a stored List at the new address of a renamed member", async () => {
    serveLetterboxd((url) =>
      url === "https://letterboxd.com/oldname/list/top-10/"
        ? new HttpResponse(null, {
            status: 301,
            headers: {
              location: "https://letterboxd.com/newname/list/top-10/",
            },
          })
        : url === "https://letterboxd.com/newname/list/top-10/"
          ? new HttpResponse(page([1, 2]))
          : undefined,
    );
    const snapshot = await letterboxdProvider.fetchSource(
      "users/oldname/lists/top-10",
      { connection: null },
    );
    expect(snapshot.complete).toBe(true);
    expect(snapshot.entries.map((entry) => entry.title)).toEqual([
      "Film 1",
      "Film 2",
    ]);
  });

  it("follows a renamed member's share link and keeps its token encrypted", async () => {
    const token = "2OS5xaC1fJOBBvGv";
    serveLetterboxd((url) =>
      url === `https://letterboxd.com/oldname/list/top-10/share/${token}/`
        ? new HttpResponse(null, {
            status: 301,
            headers: { location: `/newname/list/top-10/share/${token}/` },
          })
        : url === `https://letterboxd.com/newname/list/top-10/share/${token}/`
          ? new HttpResponse(page([1]))
          : undefined,
    );
    const res = await resolve(
      `https://letterboxd.com/oldname/list/top-10/share/${token}/`,
    );
    const body = await readJson(res, sourceRefBody);
    expect(body).toMatchObject({ ok: true, provider: "letterboxd" });
    const { sourceRef } = body;
    expect(sourceRef.startsWith("share/v1:")).toBe(true);
    expect(sourceRef).not.toContain(token);
    expect(decryptSecret(sourceRef.slice("share/".length))).toBe(
      `newname/list/top-10/share/${token}`,
    );
  });

  it.each([
    ["the home page", "/"],
    ["another kind of page", "/newname/films/"],
    ["another site", "https://example.com/newname/watchlist/"],
  ])("does not follow a redirect to %s", async (_, location) => {
    serveLetterboxd(
      () => new HttpResponse(null, { status: 301, headers: { location } }),
    );
    const sent = outsideRequests();
    const res = await resolve("https://letterboxd.com/oldname/watchlist/");
    expect(await res.json()).toEqual({
      ok: false,
      reason: "unavailable",
      provider: "letterboxd",
    });
    expect(sent).toEqual(["https://letterboxd.com/oldname/watchlist/"]);
  });
});

describe("a busy Letterboxd", () => {
  it("answers a 429 with the queue state and the wait, not with try again", async () => {
    serveLetterboxd(
      () =>
        new HttpResponse("slow down", {
          status: 429,
          headers: { "Retry-After": "120" },
        }),
    );
    const res = await resolve("https://letterboxd.com/leo/watchlist/");
    expect(await res.json()).toMatchObject({
      ok: false,
      reason: "queued",
      provider: "letterboxd",
      waitMs: 120_000,
    });
  });

  it("waits at least the 60 s pause after a 429 without Retry-After", async () => {
    serveLetterboxd(() => new HttpResponse("slow down", { status: 429 }));
    const res = await resolve("https://boxd.it/YtpP8");
    expect(await res.json()).toMatchObject({
      ok: false,
      reason: "queued",
      provider: "letterboxd",
      waitMs: 60_000,
    });
  });

  it("previews a List with the queue state after a 429", async () => {
    serveLetterboxd(
      () =>
        new HttpResponse("slow down", {
          status: 429,
          headers: { "Retry-After": "90" },
        }),
    );
    const preview = await app.request("/lists/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "letterboxd",
        sourceRef: "users/leo/watchlist",
        sortOption: "added_at-asc",
      }),
    });
    expect(await preview.json()).toMatchObject({
      ok: false,
      reason: "queued",
      provider: "letterboxd",
      waitMs: 90_000,
    });
  });
});
