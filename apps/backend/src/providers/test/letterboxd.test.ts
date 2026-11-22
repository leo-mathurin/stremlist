import { http, HttpResponse } from "msw";
import { createHash } from "node:crypto";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { z } from "zod";
import { useBackgroundTasks } from "../../test/helpers/background.test-utils";
import { untilSettled } from "../../test/helpers/clock.test-utils";
import {
  FakeLetterboxd,
  LETTERBOXD,
  letterboxdFilmPage,
  letterboxdPage as page,
} from "../../test/helpers/letterboxd.test-utils";
import {
  callRpc,
  db,
  resetRpc,
  rpcHandlers,
} from "../../test/helpers/mock-supabase";
import { useMswServer } from "../../test/helpers/msw.test-utils";
import { r2Objects, resetR2 } from "../../test/helpers/r2.test-utils";
import {
  letterboxdGate,
  letterboxdGateRpcs,
  letterboxdWaiters,
} from "../../test/helpers/supabase/letterboxd-gate-rpcs";
import { FakeWikidata } from "../../test/helpers/wikidata.test-utils";
import { resolveEntries } from "../../titles/resolver";
import { letterboxdProvider } from "../letterboxd";
import { letterboxdSnapshot } from "../letterboxd-cache";
import { LetterboxdBusyError, withLetterboxdPermit } from "../letterboxd-gate";
import {
  letterboxdSnapshotSchema,
  parseLetterboxdPage,
} from "../letterboxd-page";
import {
  recordLetterboxdRequest,
  requestDetails,
} from "../letterboxd-request-log";
import { readQueue, withReadPriority } from "../read-priority";

const server = useMswServer();
const background = useBackgroundTasks();
const letterboxd = new FakeLetterboxd();
const wikidata = new FakeWikidata();

function respond(
  code: number,
  body = "",
  headers: Record<string, string> = {},
) {
  return () => new HttpResponse(body, { status: code, headers });
}

const context = { connection: null };
const ref = "users/alice/watchlist";
const stateSchema = z.object({
  snapshot: letterboxdSnapshotSchema.nullable().optional(),
});
function stored(key: string) {
  return stateSchema.parse(JSON.parse(r2Objects.get(key) ?? "null"));
}
function gate() {
  const value = letterboxdGate();
  if (!value) throw new Error("No Letterboxd request went through the gate");
  return value;
}
async function readRefused(count: number) {
  for (let i = 0; i < count; i++) {
    await expect(
      letterboxdProvider.fetchSource(`users/reader${i}/watchlist`, context),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await background.settle();
  }
}
let testTime = Date.parse("2026-11-05T18:00:00Z");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(testTime);
  testTime += 24 * 60 * 60_000;
  resetR2();
  db.reset();
  resetRpc();
  letterboxd.reset();
  wikidata.reset();
  server.use(...letterboxd.handlers, wikidata.handler);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Letterboxd public reads", () => {
  it("resolves 50 slug matches with two bulk Wikidata requests and no film reads", async () => {
    const entries = Array.from({ length: 50 }, (_, index) => ({
      externalIds: {
        letterboxd: { uid: `film:${index + 1}`, slug: `film-${index + 1}` },
      },
    }));
    entries.forEach((entry, index) =>
      wikidata.link(
        "P6127",
        entry.externalIds.letterboxd.slug,
        `tt${index + 1}`,
      ),
    );
    const pending = resolveEntries(letterboxdProvider, entries);
    const result = await untilSettled(pending);
    expect(result.resolved).toHaveLength(50);
    expect(result.deferred).toBe(0);
    expect(wikidata.queries).toHaveLength(2);
    expect(letterboxd.requests).toHaveLength(0);
    expect(db.getTable("title_id_map")).toHaveLength(50);
  });

  it.each([0, 1])(
    "defers a failed film and unread films without negative cache rows (failure at %i)",
    async (failedAt) => {
      const entries = Array.from({ length: 3 }, (_, index) => ({
        externalIds: {
          letterboxd: { uid: `film:${index + 1}`, slug: `film-${index + 1}` },
        },
      }));
      let fail = true;
      const films = letterboxd.requests;
      letterboxd.serveAll(({ url }) => {
        if (fail && films.length === failedAt + 1)
          return new HttpResponse("Unavailable", { status: 503 });
        const id = /film-(\d+)/.exec(url)?.[1];
        if (!id) throw new Error("Unexpected film URL");
        return new HttpResponse(letterboxdFilmPage(`tt${id}`));
      });
      const pending = resolveEntries(letterboxdProvider, entries);
      const result = await untilSettled(pending);
      expect(result.resolved).toHaveLength(failedAt);
      expect(result.deferred).toBe(3 - failedAt);
      expect(db.getTable("title_id_map")).toHaveLength(failedAt);
      expect(films).toHaveLength(failedAt + 1);
      expect(
        db
          .getTable("title_id_map")
          .every((row) => typeof row.imdb_id === "string"),
      ).toBe(true);
      fail = false;
      await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
      const retry = resolveEntries(letterboxdProvider, entries);
      expect((await untilSettled(retry)).resolved).toHaveLength(3);
      expect(db.getTable("title_id_map")).toHaveLength(3);
    },
  );

  it("requires explicit document and empty-grid end tags", () => {
    const truncated =
      '<html><head><title>List • Letterboxd</title></head><body><ul class="poster-list -grid">';
    expect(parseLetterboxdPage(truncated).valid).toBe(false);
    expect(parseLetterboxdPage(page([]).replace("</ul>", "")).valid).toBe(
      false,
    );
    expect(parseLetterboxdPage(page([1]).split("</body>")[0]).valid).toBe(
      false,
    );
    expect(
      parseLetterboxdPage(
        truncated + '</ul><script>const text="</body></html>";</script>',
      ).valid,
    ).toBe(false);
    expect(parseLetterboxdPage(page([])).valid).toBe(true);
  });

  it("a truncated manual refresh retains the populated page snapshot", async () => {
    letterboxd.serveAll(page([1]));
    await letterboxdProvider.fetchSource(ref, context);
    await vi.advanceTimersByTimeAsync(5000);
    letterboxd.serveAll(
      '<html><head><title>List • Letterboxd</title></head><body><ul class="poster-list -grid">',
    );
    await expect(
      letterboxdProvider.fetchSource(ref, { ...context, forceRefresh: true }),
    ).rejects.toMatchObject({ reason: "unavailable" });
    for (const key of r2Objects.keys())
      if (key.includes("pages-v2")) {
        expect(stored(key).snapshot?.films.map((film) => film.uid)).toEqual([
          "film:1",
        ]);
      }
  });

  it("counts invalid pagination as a failed read, and slows down above 20% of 20 reads", async () => {
    letterboxd.serveAll(page([1], "/alice/watchlist/"));
    async function failedRead(count: number) {
      const read = letterboxdProvider.fetchSource(
        `users/u${count}/watchlist`,
        context,
      );
      read.catch(() => {});
      await vi.advanceTimersByTimeAsync(200);
      await expect(read).rejects.toMatchObject({ reason: "unavailable" });
    }
    for (let count = 1; count <= 19; count++) {
      await failedRead(count);
      expect(gate()).toMatchObject({ windowFailures: count, rate: 10 });
    }
    await failedRead(20);
    expect(gate()).toMatchObject({ rate: 5, haltedAt: null });
    expect(gate().pausedUntil).toBeGreaterThan(Date.now() + 59_000);
    await expect(
      letterboxdProvider.fetchSource("users/u21/watchlist", context),
    ).rejects.toBeInstanceOf(LetterboxdBusyError);
    expect(letterboxd.requests).toHaveLength(20);
  });
  it("does not treat a real list named Access Denied as a challenge", () => {
    const result = parseLetterboxdPage(
      page([1]).replace(
        "Alice's list • Letterboxd",
        "Access Denied • Letterboxd",
      ),
    );
    expect(result).toMatchObject({ valid: true, blocked: false });
  });

  it("marks a capped pagination walk incomplete", async () => {
    letterboxd.serveAll(({ url }) => {
      const number = Number(/\/page\/(\d+)\//.exec(url)?.[1] ?? 1);
      return new HttpResponse(
        page([number], `/alice/list/capped/page/${number + 1}/`),
      );
    });
    const pending = letterboxdProvider.fetchSource(
      "users/alice/lists/capped",
      context,
    );
    expect((await untilSettled(pending)).complete).toBe(false);
    expect((await pending).entries).toHaveLength(100);
  });
  it("a manual refresh revalidates shared pages instead of waiting six hours", async () => {
    letterboxd.serveAll(page([1]));
    await letterboxdProvider.fetchSource(ref, context);
    await vi.advanceTimersByTimeAsync(5000);
    letterboxd.serveAll(page([2, 1]));
    expect(
      (await letterboxdProvider.fetchSource(ref, context)).entries,
    ).toHaveLength(1);
    expect(
      (
        await letterboxdProvider.fetchSource(ref, {
          ...context,
          forceRefresh: true,
        })
      ).entries,
    ).toHaveLength(2);
    expect(letterboxd.requests).toHaveLength(2);
  });

  it("resolves an uncatalogued film only through an exact IMDb link", async () => {
    const strategy = letterboxdProvider.resolverStrategies?.find(
      (strategy) => strategy.name === "letterboxd-film-links",
    );
    if (!strategy) throw new Error("Missing film link resolver");
    letterboxd.serve(
      `${LETTERBOXD}/film/film-1/`,
      '<title>Film • Letterboxd</title><a data-track-action="IMDb" href="http://www.imdb.com/title/tt0111161/maindetails">IMDb</a><a data-track-action="IMDb" href="https://evil.example/title/tt9999999/">Wrong host</a><a href="https://www.imdb.com/title/tt9999999/">A user review link</a>',
    );
    expect(
      await strategy.resolve([
        { externalIds: { letterboxd: { uid: "film:1", slug: "film-1" } } },
      ]),
    ).toEqual(new Map([[0, "tt0111161"]]));
    expect(letterboxd.urls).toEqual([`${LETTERBOXD}/film/film-1/`]);
  });

  it("reads a full paginated list and resolves a film linked by its UID", async () => {
    const listPath = "/alice/list/mixed/";
    const nextPage = `${listPath}page/2/`;
    const filmUrl = `${LETTERBOXD}/film/film:2/`;
    letterboxd.serve(`${LETTERBOXD}${listPath}`, page([1], nextPage));
    letterboxd.serve(
      `${LETTERBOXD}${nextPage}`,
      page([2, 3]).replace(
        'data-item-slug="film-2"',
        'data-item-slug="film:2"',
      ),
    );
    letterboxd.serve(filmUrl, letterboxdFilmPage("tt0111161"));

    const read = letterboxdProvider.fetchSource(
      "users/alice/lists/mixed",
      context,
    );
    const result = await untilSettled(read);
    expect(result.complete).toBe(true);
    expect(result.entries.map((entry) => entry.sourceUrl)).toEqual([
      `${LETTERBOXD}/film/film-1/`,
      filmUrl,
      `${LETTERBOXD}/film/film-3/`,
    ]);
    const resolution = resolveEntries(
      letterboxdProvider,
      result.entries.slice(1, 2),
    );
    expect((await untilSettled(resolution)).resolved[0]?.imdbId).toBe(
      "tt0111161",
    );
    expect(letterboxd.urls).toContain(filmUrl);
  });

  it("rejects a film path that points to a different UID than the card", () => {
    const html = page([1]).replace(
      'data-item-slug="film-1"',
      'data-item-slug="film:2"',
    );
    expect(parseLetterboxdPage(html).valid).toBe(false);
  });

  it("keeps the old snapshot after a transient refresh failure, but not after a 404", async () => {
    const path = "/alice/watchlist/";
    const url = `${LETTERBOXD}${path}`;
    const pageKey = `${createHash("sha256").update(path).digest("hex")}.json`;
    const legacyKey = `providers/letterboxd/pages-v1/${pageKey}`;
    const oldSnapshot = {
      films: [{ uid: "film:1", slug: "film-1", title: "Film 1" }],
      complete: true,
      title: "A list",
    };
    r2Objects.set(
      legacyKey,
      JSON.stringify({
        snapshot: oldSnapshot,
        fetchedAt: Date.now(),
        leaseId: null,
        leaseUntil: 0,
      }),
    );
    const cached = await letterboxdProvider.fetchSource(ref, context);
    expect(cached.entries.map((entry) => entry.title)).toEqual(["Film 1"]);
    expect(letterboxd.urls).toEqual([]);

    letterboxd.fail(url, 503);
    const forceRefresh = { ...context, forceRefresh: true };
    await expect(
      letterboxdProvider.fetchSource(ref, forceRefresh),
    ).rejects.toMatchObject({ reason: "unavailable" });
    const recovered = await letterboxdProvider.fetchSource(ref, context);
    expect(recovered.entries.map((entry) => entry.title)).toEqual(["Film 1"]);
    expect(letterboxd.urls).toEqual([url]);

    letterboxd.fail(url, 404);
    await expect(
      letterboxdProvider.fetchSource(ref, forceRefresh),
    ).rejects.toMatchObject({ reason: "not_found" });
    await expect(
      letterboxdProvider.fetchSource(ref, context),
    ).rejects.toMatchObject({ reason: "not_found" });

    letterboxd.serve(
      url,
      page([2]).replace('data-item-slug="film-2"', 'data-item-slug="film:2"'),
    );
    const refreshed = await letterboxdProvider.fetchSource(ref, {
      ...context,
      forceRefresh: true,
    });
    expect(refreshed.entries.map((entry) => entry.sourceUrl)).toEqual([
      `${LETTERBOXD}/film/film:2/`,
    ]);
    expect(letterboxd.urls).toEqual([url, url, url, url]);
    expect(stored(legacyKey).snapshot).toEqual(oldSnapshot);
    expect(
      stored(`providers/letterboxd/pages-v2/${pageKey}`).snapshot?.films[0],
    ).toMatchObject({ uid: "film:2", slug: "film:2" });
  });

  it.each([200, 503])(
    "counts a challenge in an HTTP %i response as a refusal",
    async (status) => {
      letterboxd.serveAll(respond(status, "<title>Just a moment...</title>"));
      await readRefused(1);
      expect(gate()).toMatchObject({ haltedAt: null, blockedCount: 1 });
    },
  );
  it("shares validated pages across accounts, resolves links and keeps stable entry IDs", async () => {
    letterboxd.serve(`${LETTERBOXD}/alice/watchlist/`, page([2, 1]));
    expect(await letterboxdProvider.validateSource(ref, context)).toMatchObject(
      { ok: true, ref },
    );
    const result = await letterboxdProvider.fetchSource(ref, context);
    expect(result.complete).toBe(true);
    expect(
      result.entries.map((entry) => entry.externalIds?.letterboxd?.uid),
    ).toEqual(["film:1", "film:2"]);
    expect(letterboxdProvider.resolutionKey?.(result.entries[0])).toEqual({
      namespace: "letterboxd",
      externalId: "film:1",
    });
    expect(result.entries[0].sourceUrl).toBe(
      "https://letterboxd.com/film/film-1/",
    );
    expect(letterboxd.urls).toEqual([`${LETTERBOXD}/alice/watchlist/`]);
    expect(letterboxd.requests[0].redirect).toBe("manual");
    expect(letterboxd.requests[0].headers.has("Cookie")).toBe(false);
  });
  it("walks pages and keeps a ranked list's order", async () => {
    letterboxd.serveAll(
      ({ url }) =>
        new HttpResponse(
          url.includes("/page/2/")
            ? page([3])
            : page([1, 2], "/alice/list/favorites/page/2/"),
        ),
    );
    const pending = letterboxdProvider.fetchSource(
      "users/alice/lists/favorites",
      context,
    );
    const result = await untilSettled(pending);
    expect(result.complete).toBe(true);
    expect(result.entries.map((entry) => entry.title)).toEqual([
      "Film 1",
      "Film 2",
      "Film 3",
    ]);
  });
  it("never follows hostile pagination or accepts an unverified empty page", async () => {
    letterboxd.serveAll(page([1], "https://evil.example/watchlist/page/2/"));
    await expect(
      letterboxdProvider.fetchSource(ref, context),
    ).rejects.toMatchObject({ reason: "unavailable" });
    expect(
      [...r2Objects.keys()]
        .filter((key) => key.includes("pages-v2"))
        .map((key) => stored(key).snapshot),
    ).toEqual([null]);
    expect(
      parseLetterboxdPage("<title>Letterboxd</title><body>Sign in</body>")
        .valid,
    ).toBe(false);
    expect(parseLetterboxdPage(page([]))).toMatchObject({
      valid: true,
      films: [],
    });
  });
  it("stops every instance at the third HTTP 403 within 10 minutes, with no retry", async () => {
    letterboxd.serveAll(respond(403, "refused"));
    await readRefused(2);
    expect(gate().haltedAt).toBeNull();
    await readRefused(1);
    await expect(
      letterboxdProvider.fetchSource("users/bob/watchlist", context),
    ).rejects.toMatchObject({ reason: "disabled" });
    expect(letterboxd.requests).toHaveLength(3);
    expect(gate().haltReason).toBe("blocked");
  });
  it("does not halt for refusals more than 10 minutes apart", async () => {
    letterboxd.serveAll(respond(403, "refused"));
    await readRefused(2);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await readRefused(2);
    expect(gate()).toMatchObject({ haltedAt: null, blockedCount: 2 });
  });
  it("reads a 403 with Letterboxd's Forbidden page as a private watchlist, not a refusal", async () => {
    const forbidden = `\n\n<!DOCTYPE html>\n<html>\n<head>\n\t<title>Letterboxd - Forbidden</title>\n\t<style>${" ".repeat(1200)}</style>\n\t<script>\n\t\tvar analytic_params = {};\n\t\tanalytic_params['template'] = '/errors/forbidden';\n\t</script>${" ".repeat(4000)}</head><body></body></html>`;
    let hidden = false;
    letterboxd.serveAll(({ url }) =>
      hidden && url.includes("/alice/")
        ? new HttpResponse(forbidden, {
            status: 403,
            headers: { server: "cloudflare", "cf-cache-status": "DYNAMIC" },
          })
        : new HttpResponse(page([1])),
    );
    await letterboxdProvider.fetchSource(ref, context);
    hidden = true;
    await vi.advanceTimersByTimeAsync(1000);
    await expect(
      untilSettled(
        letterboxdProvider.fetchSource(ref, { ...context, forceRefresh: true }),
      ),
    ).rejects.toMatchObject({ reason: "private" });
    await expect(
      untilSettled(letterboxdProvider.fetchSource(ref, context)),
    ).rejects.toMatchObject({ reason: "private" });
    await expect(
      untilSettled(letterboxdProvider.validateSource(ref, context)),
    ).rejects.toMatchObject({ reason: "private" });
    await untilSettled(background.settle());
    expect(gate().haltedAt).toBeNull();
    expect(
      (await letterboxdProvider.fetchSource("users/bob/watchlist", context))
        .entries,
    ).toHaveLength(1);
    await untilSettled(background.settle());
    expect(db.getTable("letterboxd_requests")).toContainEqual(
      expect.objectContaining({
        outcome: "ok",
        status: 403,
        url: "https://letterboxd.com/alice/watchlist/",
      }),
    );
  });
  it("still counts a Cloudflare challenge on Letterboxd's Forbidden page as a refusal", async () => {
    letterboxd.serveAll(
      respond(403, "<title>Letterboxd - Forbidden</title>", {
        "cf-mitigated": "challenge",
      }),
    );
    await readRefused(1);
    expect(gate().blockedCount).toBe(1);
  });
  it("slows every instance down after HTTP 429, for at least Retry-After", async () => {
    letterboxd.serveAll(respond(429, "slow down", { "Retry-After": "120" }));
    const limited = letterboxdProvider.fetchSource(ref, context);
    await expect(limited).rejects.toBeInstanceOf(LetterboxdBusyError);
    await expect(limited).rejects.toMatchObject({ waitMs: 120_000 });
    await background.settle();
    expect(gate()).toMatchObject({ rate: 5, haltedAt: null });
    expect(gate().pausedUntil).toBe(Date.now() + 120_000);
    const busy = letterboxdProvider.fetchSource("users/bob/watchlist", context);
    await expect(busy).rejects.toBeInstanceOf(LetterboxdBusyError);
    await expect(busy).rejects.toMatchObject({ waitMs: 120_000 });
    expect(letterboxd.requests).toHaveLength(1);
  });
  it("reports a halt even when the list's pages are cached", async () => {
    letterboxd.serveAll(page([1]));
    await letterboxdProvider.fetchSource(ref, context);
    gate().haltedAt = Date.now();
    gate().nextProbeAt = Date.now() + 30 * 60_000;
    await expect(
      letterboxdProvider.fetchSource(ref, context),
    ).rejects.toMatchObject({ reason: "disabled" });
    await expect(
      letterboxdProvider.validateSource(ref, context),
    ).rejects.toMatchObject({
      reason: "disabled",
    });
    expect(letterboxd.requests).toHaveLength(1);
  });
  it("keeps a timeout after HTTP 200 temporary and never caches an empty result", async () => {
    letterboxd.serveAll(
      () =>
        new HttpResponse(
          new ReadableStream({
            start(controller) {
              controller.error(new DOMException("timed out", "TimeoutError"));
            },
          }),
        ),
    );
    await expect(
      letterboxdProvider.fetchSource(ref, context),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await background.settle();
    expect(gate()).toMatchObject({
      haltedAt: null,
      windowFailures: 1,
      rate: 10,
    });
    expect(gate().pausedUntil).toBe(-Infinity);
    for (const [key, value] of r2Objects)
      if (key.includes("pages-v2"))
        expect(stateSchema.parse(JSON.parse(value)).snapshot).toBeNull();
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
    letterboxd.serveAll(page([1]));
    expect(
      (await letterboxdProvider.fetchSource(ref, context)).entries,
    ).toHaveLength(1);
  });
  it("uses exact Wikidata links without per-film Letterboxd calls", async () => {
    wikidata.link("P6127", "film-1", "tt0111161");
    const strategy = letterboxdProvider.resolverStrategies?.find(
      (strategy) => strategy.name === "letterboxd-wikidata-slug",
    );
    if (!strategy) throw new Error("Missing slug resolver");
    const result = await strategy.resolve([
      { externalIds: { letterboxd: { uid: "film:1", slug: "film-1" } } },
    ]);
    expect(result.get(0)).toBe("tt0111161");
    expect(wikidata.queries).toEqual([
      { property: "P6127", values: ["film-1"] },
    ]);
    expect(letterboxd.requests).toHaveLength(0);
  });
  it("rejects invalid references and the kill switch before any upstream request", async () => {
    await expect(
      letterboxdProvider.fetchSource("users/../watchlist", context),
    ).rejects.toMatchObject({ reason: "not_found" });
    vi.stubEnv("DISABLED_PROVIDERS", "letterboxd");
    await expect(
      letterboxdProvider.fetchSource(ref, context),
    ).rejects.toMatchObject({ reason: "disabled" });
    expect(letterboxd.requests).toHaveLength(0);
  });
});

function countedRead() {
  const read = Object.assign(
    () => {
      read.calls += 1;
      return Promise.resolve({ value: true, result: "ok" as const });
    },
    { calls: 0 },
  );
  return read;
}

describe("shared Letterboxd coordination", () => {
  const ok = () => Promise.resolve({ value: true, result: "ok" as const });

  it("lets a burst of 10 through, then paces concurrent callers at 10 requests/s", async () => {
    const sent: number[] = [];
    let active = 0;
    let maximum = 0;
    const start = Date.now();
    const requests = Array.from({ length: 30 }, () =>
      withLetterboxdPermit(async () => {
        active++;
        maximum = Math.max(maximum, active);
        sent.push(Date.now() - start);
        await new Promise((resolve) => setTimeout(resolve, 300));
        active--;
        return { value: true, result: "ok" as const };
      }),
    );
    const pending = Promise.all(requests);
    await untilSettled(pending);
    sent.sort((a, b) => a - b);
    expect(sent.filter((at) => at === 0)).toHaveLength(10);
    expect(sent[29]).toBeGreaterThanOrEqual(1900);
    expect(sent[29]).toBeLessThanOrEqual(2100);
    for (const at of sent)
      expect(
        sent.filter((other) => other > at - 1000 && other <= at).length,
      ).toBeLessThanOrEqual(20);
    expect(maximum).toBeGreaterThan(1);
  });
  it("refuses a background read when no slot is free now, without sending", async () => {
    for (let index = 0; index < 10; index++) await withLetterboxdPermit(ok);
    const read = countedRead();
    const busy = withReadPriority("background", () =>
      withLetterboxdPermit(read),
    );
    await expect(busy).rejects.toBeInstanceOf(LetterboxdBusyError);
    await expect(busy).rejects.toMatchObject({ reason: "unavailable" });
    expect(read.calls).toBe(0);
  });
  it("refuses an interactive read that would wait more than 10 s, with an estimate", async () => {
    const reserved = Array.from({ length: 110 }, () =>
      withLetterboxdPermit(ok),
    );
    const read = countedRead();
    const busy = withLetterboxdPermit(read);
    await expect(busy).rejects.toBeInstanceOf(LetterboxdBusyError);
    await expect(busy).rejects.toMatchObject({ waitMs: 10_100 });
    expect(read.calls).toBe(0);
    const pending = Promise.all(reserved);
    await untilSettled(pending);
  });
  it("does not send a request reserved over 1 s ahead when a slowdown started meanwhile", async () => {
    for (let index = 0; index < 10; index++) await withLetterboxdPermit(ok);
    const reserved = Array.from({ length: 20 }, () => countedRead());
    const pending = Promise.allSettled(
      reserved.map((read) => withLetterboxdPermit(read)),
    );
    await vi.advanceTimersByTimeAsync(50);
    await callRpc("letterboxd_report", {
      p_target: 10,
      p_outcome: "rate_limited",
      p_retry_after_ms: 0,
      p_probe: false,
    });
    const results = await untilSettled(pending);
    expect(reserved.slice(10).every((read) => read.calls === 0)).toBe(true);
    expect(
      results.slice(10).every((result) => result.status === "rejected"),
    ).toBe(true);
    expect(results[10]).toMatchObject({
      reason: expect.any(LetterboxdBusyError) as unknown,
    });
  });
  it("fails closed when the gate cannot be read", async () => {
    rpcHandlers.set("letterboxd_take_turn", () => ({
      data: null,
      error: { message: "connection refused" },
    }));
    const read = countedRead();
    await expect(withLetterboxdPermit(read)).rejects.toMatchObject({
      reason: "unavailable",
    });
    expect(read.calls).toBe(0);
  });
  it("only reads a cold shared page once and retains a previous snapshot on failure", async () => {
    let reads = 0;
    const read = () => {
      reads += 1;
      return Promise.resolve({
        films: [],
        complete: true,
        title: "Empty",
      });
    };
    const pending = Promise.all(
      Array.from({ length: 8 }, () => letterboxdSnapshot("shared-page", read)),
    );
    expect(await untilSettled(pending)).toHaveLength(8);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000 + 1);
    await expect(
      letterboxdSnapshot("shared-page", () =>
        Promise.reject(new Error("offline")),
      ),
    ).rejects.toThrow("offline");
    expect(stored("shared-page").snapshot?.title).toBe("Empty");
  });
});

describe("the Letterboxd queue", () => {
  const ok = () => Promise.resolve({ value: true, result: "ok" as const });
  async function fillGate() {
    for (let index = 0; index < 20; index++)
      await callRpc("letterboxd_take_turn", {
        p_target: 10,
        p_priority: "later",
      });
  }

  it("sends the first page of a new read before the later pages of earlier reads", async () => {
    await fillGate();
    const sent: string[] = [];
    const send = (name: string) => () => {
      sent.push(name);
      return ok();
    };
    const later = Array.from({ length: 20 }, (_, index) =>
      withLetterboxdPermit(send(`later ${index}`)),
    );
    await vi.advanceTimersByTimeAsync(10);
    const first = withLetterboxdPermit(send("first"), { first: true });
    const pending = Promise.all([...later, first]);
    await untilSettled(pending);
    expect(sent.indexOf("first")).toBeLessThanOrEqual(2);
    expect(sent.filter((name) => name !== "first")).toEqual(
      later.map((_, index) => `later ${index}`),
    );
  });

  it("keeps the place of a read that waits, across its pages, before newer reads", async () => {
    await fillGate();
    const sent: string[] = [];
    const queue = readQueue({ maxWaitMs: 60_000 });
    const older = withReadPriority(
      "interactive",
      async () => {
        await withLetterboxdPermit(() => {
          sent.push("older 2");
          return ok();
        });
        await withLetterboxdPermit(() => {
          sent.push("older 3");
          return ok();
        });
      },
      queue,
    );
    await vi.advanceTimersByTimeAsync(10);
    const newer = Array.from({ length: 30 }, (_, index) =>
      withLetterboxdPermit(() => {
        sent.push(`newer ${index}`);
        return ok();
      }),
    );
    const pending = Promise.all([older, ...newer]);
    await untilSettled(pending);
    expect(sent.indexOf("older 2")).toBe(0);
    expect(sent.indexOf("older 3")).toBeLessThanOrEqual(12);
    expect(queue.ticket).not.toBeNull();
  });

  it("answers at once with the estimate and a ticket when the wait is 3 s or more", async () => {
    await fillGate();
    const waiting = Array.from({ length: 50 }, () => withLetterboxdPermit(ok));
    await vi.advanceTimersByTimeAsync(10);
    const read = countedRead();
    const queue = readQueue({ maxWaitMs: 10_000, answerAtMs: 3_000 });
    const busy = withReadPriority(
      "interactive",
      () => withLetterboxdPermit(read, { first: false, restMs: 2_000 }),
      queue,
    );
    await expect(busy).rejects.toBeInstanceOf(LetterboxdBusyError);
    const error = await busy.catch((caught: unknown) => caught);
    if (!(error instanceof LetterboxdBusyError)) {
      throw new Error("Expected a LetterboxdBusyError");
    }
    expect(error.waitMs).toBeGreaterThanOrEqual(6_000 + 2_000);
    expect(error.ticket).toEqual(expect.any(String));
    expect(error.retryMs).toBeGreaterThan(0);
    expect(queue.ticket).toBe(error.ticket);
    expect(letterboxdWaiters().some((w) => w.id === error.ticket)).toBe(true);
    expect(read.calls).toBe(0);
    const pending = Promise.all(waiting);
    await untilSettled(pending);
  });

  it("serves the pages read so far when a later page waits too long, and the next read resumes from them", async () => {
    letterboxd.serveAll(async ({ url }) => {
      if (url.endsWith("/page/2/")) return new HttpResponse(page([3]));
      for (let index = 0; index < 60; index++)
        await callRpc("letterboxd_take_turn", {
          p_target: 10,
          p_priority: "later",
        });
      return new HttpResponse(page([1, 2], "/alice/list/big/page/2/"));
    });
    const first = withReadPriority(
      "interactive",
      () => letterboxdProvider.fetchSource("users/alice/lists/big", context),
      readQueue({ maxWaitMs: 2_000, partial: true }),
    );
    expect(await untilSettled(first)).toMatchObject({
      complete: false,
      interrupted: true,
    });
    expect((await first).entries).toHaveLength(2);
    expect(letterboxd.urls).toEqual(["https://letterboxd.com/alice/list/big/"]);

    await vi.advanceTimersByTimeAsync(60_000);
    const next = letterboxdProvider.fetchSource(
      "users/alice/lists/big",
      context,
    );
    const result = await untilSettled(next);
    expect(result.complete).toBe(true);
    expect(result.interrupted).toBeUndefined();
    expect(result.entries).toHaveLength(3);
    expect(letterboxd.urls.slice(1)).toEqual([
      "https://letterboxd.com/alice/list/big/page/2/",
    ]);
  });

  it("does not serve a read whose first page waits too long", async () => {
    await fillGate();
    for (let index = 0; index < 60; index++)
      await callRpc("letterboxd_take_turn", {
        p_target: 10,
        p_priority: "first",
      });
    const read = withReadPriority(
      "interactive",
      () => letterboxdProvider.fetchSource(ref, context),
      readQueue({ maxWaitMs: 2_000, partial: true }),
    );
    await expect(read).rejects.toBeInstanceOf(LetterboxdBusyError);
    expect(letterboxd.requests).toHaveLength(0);
  });

  it("reports its estimate again while it waits out a slowdown", async () => {
    await withLetterboxdPermit(ok);
    await callRpc("letterboxd_report", {
      p_target: 10,
      p_outcome: "rate_limited",
      p_retry_after_ms: 0,
      p_probe: false,
    });
    const estimates: number[] = [];
    const waiting = withReadPriority(
      "interactive",
      () => withLetterboxdPermit(ok),
      readQueue({
        maxWaitMs: 120_000,
        onQueued: (waitMs) => estimates.push(waitMs),
      }),
    );
    await vi.advanceTimersByTimeAsync(65_000);
    await untilSettled(waiting);
    expect(estimates.length).toBeGreaterThanOrEqual(6);
    expect(estimates[0]).toBeGreaterThan(59_000);
    expect(estimates.at(-1)).toBeLessThan(11_000);
  });

  it("counts a page that another read holds for too long as busy", async () => {
    const held = letterboxdSnapshot("held-page", () => new Promise(() => {}));
    void held;
    await vi.advanceTimersByTimeAsync(10);
    const waiting = letterboxdSnapshot("held-page", () =>
      Promise.resolve({ films: [], complete: true, title: "Empty" }),
    );
    const outcome = waiting.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await outcome).toBeInstanceOf(LetterboxdBusyError);
  });
});

describe("Letterboxd share links", () => {
  const key = Buffer.from("0123456789abcdef0123456789abcdef").toString(
    "base64",
  );
  const shareUrl =
    "https://letterboxd.com/leom/list/best-of-2026/share/2OS5xaC1fJOBBvGv/";
  const provisional = "lbxshare/leom/list/best-of-2026/share/2OS5xaC1fJOBBvGv";
  beforeEach(() => vi.stubEnv("CONNECTION_ENCRYPTION_KEY", key));

  it("never logs a share token in plaintext", async () => {
    letterboxd.serveAll(
      respond(
        403,
        '<html><link rel="canonical" href="/leom/list/best-of-2026/share/2OS5xaC1fJOBBvGv/">',
      ),
    );
    await expect(
      letterboxdProvider.validateSource(provisional, context),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await background.settle();
    const [row] = db.getTable("letterboxd_requests");
    expect(row.url).toBe(
      "https://letterboxd.com/leom/list/best-of-2026/share/[redacted]/",
    );
    expect(row.body_excerpt).toContain("/share/[redacted]/");
    expect(JSON.stringify(row)).not.toContain("2OS5xaC1fJOBBvGv");
  });

  it("encrypts the token on validate and reads the decrypted path on fetch", async () => {
    letterboxd.serve(shareUrl, page([2, 1]));

    const validated = await letterboxdProvider.validateSource(
      provisional,
      context,
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error("expected ok");
    expect(validated.ref.startsWith("share/v1:")).toBe(true);
    expect(validated.ref).not.toContain("2OS5xaC1fJOBBvGv");

    const result = await letterboxdProvider.fetchSource(validated.ref, context);
    expect(result.complete).toBe(true);
    expect(
      result.entries.map((entry) => entry.externalIds?.letterboxd?.uid),
    ).toEqual(["film:2", "film:1"]);
    expect(new Set(letterboxd.urls)).toEqual(new Set([shareUrl]));
  });

  it("gives the same share link one stable reference, caught as a duplicate", async () => {
    letterboxd.serve(shareUrl, page([1]));
    const a = await letterboxdProvider.validateSource(provisional, context);
    const b = await letterboxdProvider.validateSource(provisional, context);
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(a.ref).toBe(b.ref);
    await letterboxdProvider.fetchSource(a.ref, context);
    await letterboxdProvider.fetchSource(b.ref, context);
    expect(letterboxd.urls).toEqual([shareUrl]);
  });

  it("never reads a plaintext-token reference directly", async () => {
    await expect(
      letterboxdProvider.fetchSource(provisional, context),
    ).rejects.toMatchObject({ reason: "not_found" });
    expect(letterboxd.requests).toHaveLength(0);
  });

  it("forgets the cached page when a share link is revoked", async () => {
    const gone = () => new HttpResponse(null, { status: 404 });
    letterboxd.serve(shareUrl, page([1]));
    const validated = await letterboxdProvider.validateSource(
      provisional,
      context,
    );
    if (!validated.ok) throw new Error("expected ok");
    expect(letterboxd.urls).toEqual([shareUrl]);

    await vi.advanceTimersByTimeAsync(3001);
    letterboxd.reset();
    letterboxd.serveAll(gone);
    const revoked = letterboxdProvider.fetchSource(validated.ref, {
      ...context,
      forceRefresh: true,
    });
    revoked.catch(() => {});
    await expect(untilSettled(revoked)).rejects.toMatchObject({
      reason: "not_found",
    });

    await vi.advanceTimersByTimeAsync(3001);
    letterboxd.reset();
    letterboxd.serveAll(gone);
    const second = letterboxdProvider.fetchSource(validated.ref, context);
    second.catch(() => {});
    await expect(untilSettled(second)).rejects.toMatchObject({
      reason: "not_found",
    });
    expect(letterboxd.requests.length).toBeGreaterThan(0);
  });

  it("follows a boxd.it short link to the share page", async () => {
    const shortLink = "https://boxd.it/YtpP8$2OS5xaC1fJOBBvGv";
    letterboxd.redirect(shortLink, shareUrl);
    letterboxd.serve(shareUrl, page([1]));
    const pending = letterboxdProvider.validateSource(
      "lbxshort/YtpP8$2OS5xaC1fJOBBvGv",
      context,
    );
    const validated = await untilSettled(pending);
    if (!validated.ok) throw new Error("expected ok");
    expect(validated.ref.startsWith("share/v1:")).toBe(true);
    const result = await letterboxdProvider.fetchSource(validated.ref, context);
    expect(result.entries).toHaveLength(1);
    expect(new Set(letterboxd.urls)).toEqual(new Set([shortLink, shareUrl]));
  });

  it("resolves a public boxd.it short link to its canonical list", async () => {
    const listUrl = "https://letterboxd.com/leom/list/best-of-2026/";
    letterboxd.redirect("https://boxd.it/YtpP8", listUrl);
    letterboxd.serve(listUrl, page([1]));
    const pending = letterboxdProvider.validateSource(
      "lbxshort/YtpP8",
      context,
    );
    const validated = await untilSettled(pending);
    if (!validated.ok) throw new Error("expected ok");
    expect(validated.ref).toBe("users/leom/lists/best-of-2026");
    expect(new Set(letterboxd.urls)).toEqual(
      new Set(["https://boxd.it/YtpP8", listUrl]),
    );
  });

  it("rejects a boxd.it link that is not a list", async () => {
    letterboxd.serveAll(
      () =>
        new HttpResponse(null, {
          status: 302,
          headers: { location: "https://letterboxd.com/film/harakiri/" },
        }),
    );
    await expect(
      letterboxdProvider.validateSource("lbxshort/film1", context),
    ).rejects.toMatchObject({ reason: "not_found" });
  });
});

describe("Letterboxd member collections and charts", () => {
  it.each([
    ["users/alice/films", "https://letterboxd.com/alice/films/"],
    [
      "users/alice/films/rated/4.0-5.0",
      "https://letterboxd.com/alice/films/rated/4-5/",
    ],
    ["users/alice/likes/films", "https://letterboxd.com/alice/likes/films/"],
  ])("reads %s from %s in page order", async (sourceRef, url) => {
    letterboxd.serve(url, page([2, 1]));
    const result = await letterboxdProvider.fetchSource(sourceRef, context);
    expect(letterboxd.urls).toEqual([url]);
    expect(result.complete).toBe(true);
    expect(
      result.entries.map((entry) => entry.externalIds?.letterboxd?.uid),
    ).toEqual(["film:2", "film:1"]);
    expect(result.entries.every((entry) => entry.addedAt === undefined)).toBe(
      true,
    );
  });
  it("fails only the list when Cloudflare challenges a member film page", async () => {
    letterboxd.serve(
      `${LETTERBOXD}/alice/films/`,
      page([1], "/alice/films/page/2/"),
    );
    letterboxd.serve(
      `${LETTERBOXD}/alice/films/page/2/`,
      respond(403, "<title>Just a moment...</title>", {
        "cf-mitigated": "challenge",
      }),
    );
    letterboxd.serve(`${LETTERBOXD}/bob/watchlist/`, page([3]));
    await expect(
      letterboxdProvider.fetchSource("users/alice/films", context),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await background.settle();
    expect(gate()).toMatchObject({ haltedAt: null, windowFailures: 1 });
    expect(
      (await letterboxdProvider.fetchSource("users/bob/watchlist", context))
        .entries,
    ).toHaveLength(1);
  });
});

describe("Letterboxd live page shapes", () => {
  it("never reads the popular charts, which robots.txt disallows", async () => {
    await expect(
      letterboxdProvider.fetchSource("films/popular/this/week", context),
    ).rejects.toMatchObject({ reason: "not_found" });
    expect(letterboxd.requests).toHaveLength(0);
  });

  it("reads an empty watchlist as empty, not as a failed read", async () => {
    letterboxd.serveAll(
      `<html><head><title>alice's Watchlist • Letterboxd</title></head><body><main id="content"><h1 class="section-heading">alice wants to see 0 films</h1><section class="empty-text body-text -small"><h2 class="ui-block-heading">No films yet</h2></section></main></body></html>`,
    );
    const result = await letterboxdProvider.fetchSource(ref, context);
    expect(result).toEqual({ complete: true, entries: [] });
    await background.settle();
    expect(gate()).toMatchObject({ windowFailures: 0, windowRequests: 1 });
  });

  it("follows a rating filter's pages in Letterboxd's form of the range", async () => {
    letterboxd.serveAll(
      ({ url }) =>
        new HttpResponse(
          url.endsWith("/page/2/")
            ? page([2])
            : page([1], "/alice/films/rated/4-5/page/2/"),
        ),
    );
    const pending = letterboxdProvider.fetchSource(
      "users/alice/films/rated/4.0-5.0",
      context,
    );
    const result = await untilSettled(pending);
    expect(result.complete).toBe(true);
    expect(letterboxd.urls).toEqual([
      "https://letterboxd.com/alice/films/rated/4-5/",
      "https://letterboxd.com/alice/films/rated/4-5/page/2/",
    ]);
  });
});

describe("Letterboxd diary", () => {
  function diaryPage(entries: { id: number; date: string }[], next?: string) {
    const rows = entries
      .map(({ id, date }) => {
        const [y, m, d] = date.split("-");
        return `<tr class="diary-entry-row" data-production-uid="film:${id}"><td class="col-daydate"><a href="/alice/diary/films/for/${y}/${m}/${d}/">${d}</a></td><td class="col-production"><div data-postered-identifier='{"uid":"film:${id}"}' data-item-slug="film-${id}" data-item-name="Film ${id} (2000)"></div></td></tr>`;
      })
      .join("");
    return `<html><head><title>Alice's diary • Letterboxd</title></head><body><h1>Diary</h1><table id="diary-table" class="diary-table"><tbody>${rows}</tbody></table>${next ? `<a class="next" href="${next}">Next</a>` : ""}</body></html>`;
  }

  it("reads /diary/, keeps each Title once with its latest watch date, oldest first", async () => {
    letterboxd.serve(
      "https://letterboxd.com/alice/diary/",
      diaryPage([
        { id: 1, date: "2026-01-10" },
        { id: 2, date: "2026-03-05" },
        { id: 1, date: "2026-05-20" },
      ]),
    );
    const result = await letterboxdProvider.fetchSource(
      "users/alice/diary",
      context,
    );
    expect(result.complete).toBe(true);
    expect(
      result.entries.map((entry) => entry.externalIds?.letterboxd?.uid),
    ).toEqual(["film:2", "film:1"]);
    expect(result.entries.map((entry) => entry.addedAt)).toEqual([
      "2026-03-05T00:00:00.000Z",
      "2026-05-20T00:00:00.000Z",
    ]);
    expect(letterboxd.urls).toEqual(["https://letterboxd.com/alice/diary/"]);
  });

  it("reads rewatch pages that list the same films on different dates", async () => {
    letterboxd.serve(
      "https://letterboxd.com/alice/diary/",
      diaryPage(
        [
          { id: 1, date: "2026-05-20" },
          { id: 2, date: "2026-05-19" },
        ],
        "/alice/diary/page/2/",
      ),
    );
    letterboxd.serve(
      "https://letterboxd.com/alice/diary/page/2/",
      diaryPage([
        { id: 1, date: "2026-01-10" },
        { id: 2, date: "2026-01-09" },
      ]),
    );
    const pending = letterboxdProvider.fetchSource(
      "users/alice/diary",
      context,
    );
    const result = await untilSettled(pending);
    expect(result.complete).toBe(true);
    expect(result.entries.map((entry) => entry.addedAt)).toEqual([
      "2026-05-19T00:00:00.000Z",
      "2026-05-20T00:00:00.000Z",
    ]);
    expect(letterboxd.urls).toEqual([
      "https://letterboxd.com/alice/diary/",
      "https://letterboxd.com/alice/diary/page/2/",
    ]);
  });

  it("refuses an unrelated complete page as an empty diary", async () => {
    letterboxd.serveAll(
      "<html><head><title>Something • Letterboxd</title></head><body><h1>Something</h1></body></html>",
    );
    await expect(
      letterboxdProvider.fetchSource("users/alice/diary", context),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("accepts an empty diary", async () => {
    letterboxd.serveAll(diaryPage([]));
    const result = await letterboxdProvider.fetchSource(
      "users/alice/diary",
      context,
    );
    expect(result.complete).toBe(true);
    expect(result.entries).toEqual([]);
  });
});

describe("Letterboxd halt alert", () => {
  const heartbeat = "https://uptime.betterstack.com/api/v1/heartbeat/lbx";
  const pings: string[] = [];
  beforeEach(() => {
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_LETTERBOXD", heartbeat);
    pings.length = 0;
    const ping = ({ request }: { request: Request }) => {
      pings.push(request.url);
      return new HttpResponse("ok");
    };
    server.use(http.get(heartbeat, ping), http.post(`${heartbeat}/fail`, ping));
  });

  it("reports the halt to Better Stack once, when the shared state flips", async () => {
    letterboxd.serveAll(respond(403, "refused"));
    await readRefused(3);
    await expect(
      letterboxdProvider.fetchSource("users/bob/watchlist", context),
    ).rejects.toMatchObject({ reason: "disabled" });
    await background.settle();
    expect(pings).toEqual([`${heartbeat}/fail`]);
    expect(gate().haltedAt).not.toBeNull();
  });
  it("reports the recovery when a probe works after 30 minutes", async () => {
    let refuse = true;
    letterboxd.serveAll(() =>
      refuse
        ? new HttpResponse("refused", { status: 403 })
        : new HttpResponse(page([1])),
    );
    await readRefused(3);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    refuse = false;
    const read = letterboxdProvider.fetchSource("users/bob/watchlist", context);
    expect((await untilSettled(read)).entries).toHaveLength(1);
    await background.settle();
    expect(pings).toEqual([`${heartbeat}/fail`, heartbeat]);
    expect(gate()).toMatchObject({ haltedAt: null, rate: 0.33 });
  });

  it("does not report a successful read", async () => {
    letterboxd.serveAll(page([1]));
    await letterboxdProvider.fetchSource(ref, context);
    await background.settle();
    expect(gate().haltedAt).toBeNull();
    expect(pings).toEqual([]);
  });
});

describe("Letterboxd request log", () => {
  const kept = () => db.getTable("letterboxd_requests");
  const counted = () => db.getTable("letterboxd_request_counts");

  it("keeps a refused request in full, with its Cloudflare headers and body", async () => {
    letterboxd.serveAll(
      respond(403, "<html>Sorry, you have been blocked</html>", {
        "cf-mitigated": "challenge",
        "cf-ray": "abc-FRA",
      }),
    );
    await expect(
      letterboxdProvider.fetchSource(ref, context),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await background.settle();
    expect(kept()).toEqual([
      expect.objectContaining({
        outcome: "blocked",
        page_kind: "collection",
        url: "https://letterboxd.com/alice/watchlist/",
        status: 403,
        cf_mitigated: "challenge",
        cf_ray: "abc-FRA",
        priority: "interactive",
        body_excerpt: "<html>Sorry, you have been blocked</html>",
      }),
    ]);
  });
  it("counts every successful request and keeps 1% of them, without the body", async () => {
    letterboxd.serveAll(page([1]));
    await letterboxdProvider.fetchSource(ref, context);
    await background.settle();
    expect(counted()).toHaveLength(1);

    const url = "https://letterboxd.com/bob/watchlist/";
    const keptForBob = () => kept().filter((row) => row.url === url);
    const details = {
      ...requestDetails("collection", url),
      status: 200,
      bytes: page([1]).length,
      bodyExcerpt: page([1]),
    };
    const outcome = {
      outcome: "ok",
      durationMs: 10,
      waitMs: 0,
      priority: "interactive",
      probe: false,
    } as const;
    await recordLetterboxdRequest(details, outcome, () => 0.5);
    expect(counted()).toHaveLength(2);
    expect(keptForBob()).toHaveLength(0);

    await recordLetterboxdRequest(details, outcome, () => 0.001);
    expect(keptForBob()).toEqual([
      expect.objectContaining({
        outcome: "ok",
        status: 200,
        body_excerpt: null,
      }),
    ]);
    expect(keptForBob()[0].bytes).toBeGreaterThan(0);
  });
  it("reports a refusal to the gate within 2 s, even when its body stalls", async () => {
    const reported = Promise.withResolvers<void>();
    rpcHandlers.set("letterboxd_report", (args) => {
      const result = letterboxdGateRpcs.letterboxd_report(args);
      reported.resolve();
      return result;
    });
    letterboxd.serveAll(
      () =>
        new HttpResponse(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("<html>Blocked"));
            },
          }),
          { status: 403 },
        ),
    );
    const read = letterboxdProvider
      .fetchSource(ref, context)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await read).toMatchObject({ reason: "unavailable" });
    await reported.promise;
    expect(gate().blockedCount).toBe(1);
    expect(kept()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3000);
    await background.settle();
    expect(kept()).toEqual([
      expect.objectContaining({
        outcome: "blocked",
        body_excerpt: "<html>Blocked",
      }),
    ]);
  });
  it("keeps the first bytes of a body that breaks while it is read", async () => {
    let sent = false;
    letterboxd.serveAll(
      () =>
        new HttpResponse(
          new ReadableStream(
            {
              pull(controller) {
                if (sent) controller.error(new Error("connection reset"));
                else
                  controller.enqueue(new TextEncoder().encode("<html><head>"));
                sent = true;
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    );
    await expect(
      letterboxdProvider.fetchSource(ref, context),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await background.settle();
    expect(kept()).toEqual([
      expect.objectContaining({
        outcome: "failed",
        body_excerpt: "<html><head>",
      }),
    ]);
  });
  it("keeps a network error with no status", async () => {
    letterboxd.serveAll(() => HttpResponse.error());
    await expect(
      letterboxdProvider.fetchSource(ref, context),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await background.settle();
    expect(kept()).toEqual([
      expect.objectContaining({
        outcome: "failed",
        status: null,
        error: expect.stringContaining("Failed to fetch") as unknown,
      }),
    ]);
  });
});
