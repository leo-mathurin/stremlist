import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
vi.mock("../../lib/r2", () => import("../../__tests__/helpers/mock-r2"));
vi.mock(
  "../../lib/supabase",
  () => import("../../__tests__/helpers/mock-supabase"),
);
import {
  r2Objects,
  r2Puts,
  r2Unreadable,
} from "../../__tests__/helpers/mock-r2";
import {
  callRpc,
  db,
  rpcHandlers,
} from "../../__tests__/helpers/mock-supabase";
import {
  letterboxdGate,
  letterboxdWaiters,
} from "../../__tests__/helpers/supabase/letterboxd-gate-rpcs";
import { resolveEntries } from "../../titles/resolver";
import { letterboxdProvider } from "../letterboxd";
import { letterboxdSnapshot } from "../letterboxd-cache";
import { LetterboxdBusyError, withLetterboxdPermit } from "../letterboxd-gate";
import {
  letterboxdSnapshotSchema,
  parseLetterboxdPage,
} from "../letterboxd-page";
import { readQueue, withReadPriority } from "../read-priority";

const context = { connection: null };
const ref = "users/alice/watchlist";
const stateSchema = z.object({
  snapshot: letterboxdSnapshotSchema.nullable().optional(),
});
function stored(key: string) {
  return stateSchema.parse(JSON.parse(r2Objects.get(key) ?? "null"));
}
/** The shared gate, created by the first Letterboxd request. */
function gate() {
  const value = letterboxdGate();
  if (!value) throw new Error("No Letterboxd request went through the gate");
  return value;
}
function page(ids: number[], next?: string) {
  return `<html><head><title>Alice's list • Letterboxd</title></head><body><h1>Alice's list</h1><ul class="poster-list -grid">${ids.map((id) => `<li data-postered-identifier='{"uid":"film:${id}"}' data-item-slug="film-${id}" data-item-name="Film ${id} (2000)"></li>`).join("")}</ul>${next ? `<a class="next" href="${next}">Next</a>` : ""}</body></html>`;
}
let testTime = Date.parse("2026-11-05T18:00:00Z");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(testTime);
  testTime += 24 * 60 * 60_000;
  r2Objects.clear();
  db.reset();
  r2Unreadable.clear();
  r2Puts.before = null;
  rpcHandlers.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Letterboxd public reads", () => {
  it("resolves 50 slug matches with two bulk Wikidata requests and no film reads", async () => {
    const entries = Array.from({ length: 50 }, (_, index) => ({
      externalIds: {
        letterboxd: { uid: `film:${index + 1}`, slug: `film-${index + 1}` },
      },
    }));
    const send = vi.fn((url: string, options: RequestInit) => {
      expect(url).toBe("https://query.wikidata.org/sparql");
      if (typeof options.body !== "string")
        throw new Error("Expected a SPARQL form body");
      const query = new URLSearchParams(options.body).get("query") ?? "";
      return Promise.resolve(
        Response.json({
          results: {
            bindings: entries.flatMap((entry, index) =>
              query.includes(`"${entry.externalIds.letterboxd.slug}"`)
                ? [
                    {
                      external: { value: entry.externalIds.letterboxd.slug },
                      imdb: { value: `tt${index + 1}` },
                    },
                  ]
                : [],
            ),
          },
        }),
      );
    });
    vi.stubGlobal("fetch", send);
    const pending = resolveEntries(letterboxdProvider, entries);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.resolved).toHaveLength(50);
    expect(result.deferred).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
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
      const films: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => {
          if (url === "https://query.wikidata.org/sparql")
            return Promise.resolve(
              Response.json({ results: { bindings: [] } }),
            );
          films.push(url);
          if (fail && films.length === failedAt + 1)
            return Promise.resolve(
              new Response("Unavailable", { status: 503 }),
            );
          const id = /film-(\d+)/.exec(url)?.[1];
          if (!id) throw new Error("Unexpected film URL");
          return Promise.resolve(
            new Response(
              `<title>Film • Letterboxd</title><a data-track-action="IMDb" href="https://www.imdb.com/title/tt${id}/">IMDb</a>`,
            ),
          );
        }),
      );
      const pending = resolveEntries(letterboxdProvider, entries);
      await vi.runAllTimersAsync();
      const result = await pending;
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
      await vi.runAllTimersAsync();
      expect((await retry).resolved).toHaveLength(3);
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
    const send = vi.fn(() => Promise.resolve(new Response(page([1]))));
    vi.stubGlobal("fetch", send);
    await letterboxdProvider.fetchSource(ref, context);
    await vi.advanceTimersByTimeAsync(5000);
    send.mockImplementation(() =>
      Promise.resolve(
        new Response(
          '<html><head><title>List • Letterboxd</title></head><body><ul class="poster-list -grid">',
        ),
      ),
    );
    await expect(
      letterboxdProvider.fetchSource(ref, { ...context, forceRefresh: true }),
    ).rejects.toMatchObject({ reason: "unavailable" });
    for (const key of r2Objects.keys())
      if (key.includes("pages-v1")) {
        expect(stored(key).snapshot?.films.map((film) => film.uid)).toEqual([
          "film:1",
        ]);
      }
  });

  it("counts invalid pagination as a failed read, and slows down above 20% of 20 reads", async () => {
    const send = vi.fn(() =>
      Promise.resolve(new Response(page([1], "/alice/watchlist/"))),
    );
    vi.stubGlobal("fetch", send);
    // Each read waits for its slot once the burst is spent.
    async function failedRead(count: number) {
      const read = expect(
        letterboxdProvider.fetchSource(`users/u${count}/watchlist`, context),
      ).rejects.toMatchObject({ reason: "unavailable" });
      await vi.advanceTimersByTimeAsync(200);
      await read;
    }
    for (let count = 1; count <= 19; count++) {
      await failedRead(count);
      expect(gate()).toMatchObject({ windowFailures: count, rate: 10 });
    }
    await failedRead(20);
    expect(gate()).toMatchObject({ rate: 5, haltedAt: null });
    expect(gate().pausedUntil).toBeGreaterThan(Date.now() + 59_000);
    // The slowdown refuses new reads without sending them.
    await expect(
      letterboxdProvider.fetchSource("users/u21/watchlist", context),
    ).rejects.toBeInstanceOf(LetterboxdBusyError);
    expect(send).toHaveBeenCalledTimes(20);
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
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const number = Number(/\/page\/(\d+)\//.exec(url)?.[1] ?? 1);
        return Promise.resolve(
          new Response(
            page([number], `/alice/list/capped/page/${number + 1}/`),
          ),
        );
      }),
    );
    const pending = letterboxdProvider.fetchSource(
      "users/alice/lists/capped",
      context,
    );
    await vi.runAllTimersAsync();
    expect((await pending).complete).toBe(false);
    expect((await pending).entries).toHaveLength(100);
  });
  it("a manual refresh revalidates shared pages instead of waiting six hours", async () => {
    const send = vi.fn(() => Promise.resolve(new Response(page([1]))));
    vi.stubGlobal("fetch", send);
    await letterboxdProvider.fetchSource(ref, context);
    await vi.advanceTimersByTimeAsync(5000);
    send.mockImplementation(() => Promise.resolve(new Response(page([2, 1]))));
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
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("resolves an uncatalogued film only through an exact IMDb link", async () => {
    const strategy = letterboxdProvider.resolverStrategies?.find(
      (strategy) => strategy.name === "letterboxd-film-links",
    );
    if (!strategy) throw new Error("Missing film link resolver");
    const send = vi.fn((url: string) => {
      expect(url).toBe("https://letterboxd.com/film/film-1/");
      return Promise.resolve(
        new Response(
          '<title>Film • Letterboxd</title><a data-track-action="IMDb" href="http://www.imdb.com/title/tt0111161/maindetails">IMDb</a><a data-track-action="IMDb" href="https://evil.example/title/tt9999999/">Wrong host</a><a href="https://www.imdb.com/title/tt9999999/">A user review link</a>',
        ),
      );
    });
    vi.stubGlobal("fetch", send);
    expect(
      await strategy.resolve([
        { externalIds: { letterboxd: { uid: "film:1", slug: "film-1" } } },
      ]),
    ).toEqual(new Map([[0, "tt0111161"]]));
  });

  it.each([200, 503])(
    "a challenge in an HTTP %i response stops subsequent requests",
    async (status) => {
      const send = vi.fn(() =>
        Promise.resolve(
          new Response("<title>Just a moment...</title>", { status }),
        ),
      );
      vi.stubGlobal("fetch", send);
      await expect(
        letterboxdProvider.fetchSource(ref, context),
      ).rejects.toMatchObject({ reason: "unavailable" });
      // Once halted, Letterboxd is unavailable as a Provider ("disabled").
      await expect(
        letterboxdProvider.fetchSource("users/bob/watchlist", context),
      ).rejects.toMatchObject({ reason: "disabled" });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
  it("shares validated pages across accounts, resolves links and keeps stable entry IDs", async () => {
    const fetch = vi.fn((url: string, options: RequestInit) => {
      expect(url).toBe("https://letterboxd.com/alice/watchlist/");
      expect(options.redirect).toBe("manual");
      expect(new Headers(options.headers).has("Cookie")).toBe(false);
      return Promise.resolve(new Response(page([2, 1])));
    });
    vi.stubGlobal("fetch", fetch);
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
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("walks pages and keeps a ranked list's order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(
            url.includes("/page/2/")
              ? page([3])
              : page([1, 2], "/alice/list/favorites/page/2/"),
          ),
        ),
      ),
    );
    const pending = letterboxdProvider.fetchSource(
      "users/alice/lists/favorites",
      context,
    );
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.complete).toBe(true);
    expect(result.entries.map((entry) => entry.title)).toEqual([
      "Film 1",
      "Film 2",
      "Film 3",
    ]);
  });
  it("never follows hostile pagination or accepts an unverified empty page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(page([1], "https://evil.example/watchlist/page/2/")),
        ),
      ),
    );
    await expect(
      letterboxdProvider.fetchSource(ref, context),
    ).rejects.toMatchObject({ reason: "unavailable" });
    expect(
      [...r2Objects.keys()]
        .filter((key) => key.includes("pages-v1"))
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
  it("stops every instance after HTTP 403, with no retry", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(new Response("refused", { status: 403 })),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      letterboxdProvider.fetchSource(ref, context),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await vi.advanceTimersByTimeAsync(0);
    // Once halted, Letterboxd is unavailable as a Provider ("disabled").
    await expect(
      letterboxdProvider.fetchSource("users/bob/watchlist", context),
    ).rejects.toMatchObject({ reason: "disabled" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(gate().haltReason).toBe("blocked");
  });
  it("slows every instance down after HTTP 429, for at least Retry-After", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "120" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      letterboxdProvider.fetchSource(ref, context),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await vi.advanceTimersByTimeAsync(0);
    expect(gate()).toMatchObject({ rate: 5, haltedAt: null });
    expect(gate().pausedUntil).toBe(Date.now() + 120_000);
    const busy = letterboxdProvider.fetchSource("users/bob/watchlist", context);
    await expect(busy).rejects.toBeInstanceOf(LetterboxdBusyError);
    await expect(busy).rejects.toMatchObject({ waitMs: 120_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("reports a halt even when the list's pages are cached", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(page([1]))));
    vi.stubGlobal("fetch", fetch);
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
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps a timeout after HTTP 200 temporary and never caches an empty result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new DOMException("timed out", "TimeoutError"));
              },
            }),
          ),
        ),
      ),
    );
    await expect(
      letterboxdProvider.fetchSource(ref, context),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await vi.advanceTimersByTimeAsync(0);
    // One failed read is counted, not paused on.
    expect(gate()).toMatchObject({
      haltedAt: null,
      windowFailures: 1,
      rate: 10,
    });
    expect(gate().pausedUntil).toBe(-Infinity);
    for (const [key, value] of r2Objects)
      if (key.includes("pages-v1"))
        expect(stateSchema.parse(JSON.parse(value)).snapshot).toBeNull();
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(page([1])))),
    );
    expect(
      (await letterboxdProvider.fetchSource(ref, context)).entries,
    ).toHaveLength(1);
  });
  it("uses exact Wikidata links without per-film Letterboxd calls", async () => {
    const fetch = vi.fn((url: string) => {
      expect(url).toBe("https://query.wikidata.org/sparql");
      return Promise.resolve(
        Response.json({
          results: {
            bindings: [
              { external: { value: "film-1" }, imdb: { value: "tt0111161" } },
            ],
          },
        }),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const strategy = letterboxdProvider.resolverStrategies?.find(
      (strategy) => strategy.name === "letterboxd-wikidata-slug",
    );
    if (!strategy) throw new Error("Missing slug resolver");
    const result = await strategy.resolve([
      { externalIds: { letterboxd: { uid: "film:1", slug: "film-1" } } },
    ]);
    expect(result.get(0)).toBe("tt0111161");
  });
  it("rejects invalid references and the kill switch before any upstream request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      letterboxdProvider.fetchSource("users/../watchlist", context),
    ).rejects.toMatchObject({ reason: "not_found" });
    vi.stubEnv("DISABLED_PROVIDERS", "letterboxd");
    await expect(
      letterboxdProvider.fetchSource(ref, context),
    ).rejects.toMatchObject({ reason: "disabled" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

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
    await vi.runAllTimersAsync();
    await pending;
    sent.sort((a, b) => a - b);
    expect(sent.filter((at) => at === 0)).toHaveLength(10);
    // The next 20 follow one slot every 100 ms.
    expect(sent[29]).toBeGreaterThanOrEqual(1900);
    expect(sent[29]).toBeLessThanOrEqual(2100);
    for (const at of sent)
      expect(
        sent.filter((other) => other > at - 1000 && other <= at).length,
      ).toBeLessThanOrEqual(20);
    // Requests overlap: there is no single request in flight any more.
    expect(maximum).toBeGreaterThan(1);
  });
  it("refuses a background read when no slot is free now, without sending", async () => {
    for (let index = 0; index < 10; index++) await withLetterboxdPermit(ok);
    const read = vi.fn(ok);
    const busy = withReadPriority("background", () =>
      withLetterboxdPermit(read),
    );
    await expect(busy).rejects.toBeInstanceOf(LetterboxdBusyError);
    await expect(busy).rejects.toMatchObject({ reason: "unavailable" });
    expect(read).not.toHaveBeenCalled();
  });
  it("refuses an interactive read that would wait more than 10 s, with an estimate", async () => {
    // 10 free slots, then 100 reserved ones: the next slot is 10.1 s away.
    const reserved = Array.from({ length: 110 }, () =>
      withLetterboxdPermit(ok),
    );
    const read = vi.fn(ok);
    const busy = withLetterboxdPermit(read);
    await expect(busy).rejects.toBeInstanceOf(LetterboxdBusyError);
    await expect(busy).rejects.toMatchObject({ waitMs: 10_100 });
    expect(read).not.toHaveBeenCalled();
    const pending = Promise.all(reserved);
    await vi.runAllTimersAsync();
    await pending;
  });
  it("does not send a request reserved over 1 s ahead when a slowdown started meanwhile", async () => {
    for (let index = 0; index < 10; index++) await withLetterboxdPermit(ok);
    // Slots every 100 ms: the 10th reserved read waits 1 s, the 11th 1.1 s.
    const reserved = Array.from({ length: 20 }, () => vi.fn(ok));
    const pending = Promise.allSettled(
      reserved.map((read) => withLetterboxdPermit(read)),
    );
    await vi.advanceTimersByTimeAsync(50);
    // Another instance records a 429.
    await callRpc("letterboxd_report", {
      p_target: 10,
      p_outcome: "rate_limited",
      p_retry_after_ms: 0,
      p_probe: false,
    });
    await vi.runAllTimersAsync();
    const results = await pending;
    // Reads due within 1 s still go; the later ones check the gate and stop.
    expect(
      reserved.slice(10).every((read) => read.mock.calls.length === 0),
    ).toBe(true);
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
    const read = vi.fn(ok);
    await expect(withLetterboxdPermit(read)).rejects.toMatchObject({
      reason: "unavailable",
    });
    expect(read).not.toHaveBeenCalled();
  });
  it("only reads a cold shared page once and retains a previous snapshot on failure", async () => {
    const read = vi.fn(() =>
      Promise.resolve({
        films: [],
        complete: true,
        title: "Empty",
      }),
    );
    const pending = Promise.all(
      Array.from({ length: 8 }, () => letterboxdSnapshot("shared-page", read)),
    );
    await vi.runAllTimersAsync();
    expect(await pending).toHaveLength(8);
    expect(read).toHaveBeenCalledTimes(1);
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
  /** Take every slot of the next second, so new requests wait in the queue. */
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
    await vi.runAllTimersAsync();
    await pending;
    // Grants are reserved at most 1 s ahead: only the later pages granted
    // before the first page asked go before it.
    expect(sent.indexOf("first")).toBeLessThanOrEqual(2);
    expect(sent.filter((name) => name !== "first")).toEqual(
      later.map((_, index) => `later ${index}`),
    );
  });

  it("keeps the place of a read that waits, across its pages, before newer reads", async () => {
    await fillGate();
    const sent: string[] = [];
    const queue = readQueue({ maxWaitMs: 60_000 });
    // An older read waits for its second page, then asks for its third.
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
    await vi.runAllTimersAsync();
    await pending;
    expect(sent.indexOf("older 2")).toBe(0);
    // Its next page keeps the older place: only the newer reads granted in
    // the second before it asked (10 slots) go first, not all 30.
    expect(sent.indexOf("older 3")).toBeLessThanOrEqual(12);
    expect(queue.ticket).not.toBeNull();
  });

  it("answers at once with the estimate and a ticket when the wait is 3 s or more", async () => {
    // 50 reads already wait: about 6 s.
    await fillGate();
    const waiting = Array.from({ length: 50 }, () => withLetterboxdPermit(ok));
    await vi.advanceTimersByTimeAsync(10);
    const read = vi.fn(ok);
    const queue = readQueue({ maxWaitMs: 10_000, answerAtMs: 3_000 });
    const busy = withReadPriority(
      "interactive",
      () => withLetterboxdPermit(read, { first: false, restMs: 2_000 }),
      queue,
    );
    await expect(busy).rejects.toBeInstanceOf(LetterboxdBusyError);
    const error = (await busy.catch(
      (caught: unknown) => caught,
    )) as LetterboxdBusyError;
    expect(error.waitMs).toBeGreaterThanOrEqual(6_000 + 2_000);
    expect(error.ticket).toEqual(expect.any(String));
    expect(error.retryMs).toBeGreaterThan(0);
    expect(queue.ticket).toBe(error.ticket);
    expect(letterboxdWaiters().some((w) => w.id === error.ticket)).toBe(true);
    expect(read).not.toHaveBeenCalled();
    const pending = Promise.all(waiting);
    await vi.runAllTimersAsync();
    await pending;
  });

  it("serves the pages read so far when a later page waits too long, and the next read resumes from them", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.endsWith("/page/2/")) return new Response(page([3]));
        // Other reads take the next seconds while the first page loads.
        for (let index = 0; index < 60; index++)
          await callRpc("letterboxd_take_turn", {
            p_target: 10,
            p_priority: "later",
          });
        return new Response(page([1, 2], "/alice/list/big/page/2/"));
      }),
    );
    const first = withReadPriority(
      "interactive",
      () => letterboxdProvider.fetchSource("users/alice/lists/big", context),
      readQueue({ maxWaitMs: 2_000, partial: true }),
    );
    await vi.runAllTimersAsync();
    expect(await first).toMatchObject({ complete: false, interrupted: true });
    expect((await first).entries).toHaveLength(2);
    expect(urls).toEqual(["https://letterboxd.com/alice/list/big/"]);

    await vi.advanceTimersByTimeAsync(60_000);
    const next = letterboxdProvider.fetchSource(
      "users/alice/lists/big",
      context,
    );
    await vi.runAllTimersAsync();
    const result = await next;
    expect(result.complete).toBe(true);
    expect(result.interrupted).toBeUndefined();
    expect(result.entries).toHaveLength(3);
    // The first page came from the cache.
    expect(urls.slice(1)).toEqual([
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
    vi.stubGlobal("fetch", vi.fn());
    const read = withReadPriority(
      "interactive",
      () => letterboxdProvider.fetchSource(ref, context),
      readQueue({ maxWaitMs: 2_000, partial: true }),
    );
    await expect(read).rejects.toBeInstanceOf(LetterboxdBusyError);
    expect(fetch).not.toHaveBeenCalled();
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
    await waiting;
    // Every 10 s at least, so the configure page never drops it.
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
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            '<html><link rel="canonical" href="/leom/list/best-of-2026/share/2OS5xaC1fJOBBvGv/">',
            { status: 403 },
          ),
        ),
      ),
    );
    await expect(
      letterboxdProvider.validateSource(provisional, context),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await vi.advanceTimersByTimeAsync(0);
    const [row] = db.getTable("letterboxd_requests");
    expect(row.url).toBe(
      "https://letterboxd.com/leom/list/best-of-2026/share/[redacted]/",
    );
    expect(row.body_excerpt).toContain("/share/[redacted]/");
    expect(JSON.stringify(row)).not.toContain("2OS5xaC1fJOBBvGv");
  });

  it("encrypts the token on validate and reads the decrypted path on fetch", async () => {
    const fetch = vi.fn((url: string) => {
      expect(url).toBe(shareUrl);
      return Promise.resolve(new Response(page([2, 1])));
    });
    vi.stubGlobal("fetch", fetch);

    const validated = await letterboxdProvider.validateSource(
      provisional,
      context,
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error("expected ok");
    // The stored reference encrypts the token and never carries it in plaintext.
    expect(validated.ref.startsWith("share/v1:")).toBe(true);
    expect(validated.ref).not.toContain("2OS5xaC1fJOBBvGv");

    const result = await letterboxdProvider.fetchSource(validated.ref, context);
    expect(result.complete).toBe(true);
    // A shared list keeps page order (no watchlist reversal).
    expect(
      result.entries.map((entry) => entry.externalIds?.letterboxd?.uid),
    ).toEqual(["film:2", "film:1"]);
  });

  it("gives the same share link one stable reference, caught as a duplicate", async () => {
    const fetch = vi.fn((url: string) => {
      expect(url).toBe(shareUrl);
      return Promise.resolve(new Response(page([1])));
    });
    vi.stubGlobal("fetch", fetch);
    const a = await letterboxdProvider.validateSource(provisional, context);
    const b = await letterboxdProvider.validateSource(provisional, context);
    if (!a.ok || !b.ok) throw new Error("expected ok");
    // Stable encryption: the same share link always yields the same reference,
    // so the (account, provider, source_ref) uniqueness catches a re-add, and
    // both reads share one cached page.
    expect(a.ref).toBe(b.ref);
    await letterboxdProvider.fetchSource(a.ref, context);
    await letterboxdProvider.fetchSource(b.ref, context);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never reads a plaintext-token reference directly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("no request expected");
      }),
    );
    await expect(
      letterboxdProvider.fetchSource(provisional, context),
    ).rejects.toMatchObject({ reason: "not_found" });
  });

  it("forgets the cached page when a share link is revoked", async () => {
    const first = vi.fn((url: string) => {
      expect(url).toBe(shareUrl);
      return Promise.resolve(new Response(page([1])));
    });
    vi.stubGlobal("fetch", first);
    const validated = await letterboxdProvider.validateSource(
      provisional,
      context,
    );
    if (!validated.ok) throw new Error("expected ok");

    // Time passes, then the link is revoked: a forced read now gets 404.
    await vi.advanceTimersByTimeAsync(3001);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("gone", { status: 404 }))),
    );
    const revoked = expect(
      letterboxdProvider.fetchSource(validated.ref, {
        ...context,
        forceRefresh: true,
      }),
    ).rejects.toMatchObject({ reason: "not_found" });
    await vi.runAllTimersAsync();
    await revoked;

    // The stale snapshot is gone, so an ordinary read re-requests and fails too,
    // instead of serving the Titles cached before the revocation.
    await vi.advanceTimersByTimeAsync(3001);
    const after = vi.fn(() =>
      Promise.resolve(new Response("gone", { status: 404 })),
    );
    vi.stubGlobal("fetch", after);
    const second = expect(
      letterboxdProvider.fetchSource(validated.ref, context),
    ).rejects.toMatchObject({ reason: "not_found" });
    await vi.runAllTimersAsync();
    await second;
    expect(after).toHaveBeenCalled();
  });

  it("follows a boxd.it short link to the share page", async () => {
    const fetch = vi.fn((url: string) => {
      if (url === "https://boxd.it/YtpP8$2OS5xaC1fJOBBvGv")
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: shareUrl } }),
        );
      expect(url).toBe(shareUrl);
      return Promise.resolve(new Response(page([1])));
    });
    vi.stubGlobal("fetch", fetch);
    const pending = letterboxdProvider.validateSource(
      "lbxshort/YtpP8$2OS5xaC1fJOBBvGv",
      context,
    );
    await vi.runAllTimersAsync();
    const validated = await pending;
    if (!validated.ok) throw new Error("expected ok");
    expect(validated.ref.startsWith("share/v1:")).toBe(true);
    const result = await letterboxdProvider.fetchSource(validated.ref, context);
    expect(result.entries).toHaveLength(1);
  });

  it("resolves a public boxd.it short link to its canonical list", async () => {
    const listUrl = "https://letterboxd.com/leom/list/best-of-2026/";
    const fetch = vi.fn((url: string) => {
      if (url === "https://boxd.it/YtpP8")
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: listUrl } }),
        );
      expect(url).toBe(listUrl);
      return Promise.resolve(new Response(page([1])));
    });
    vi.stubGlobal("fetch", fetch);
    const pending = letterboxdProvider.validateSource(
      "lbxshort/YtpP8",
      context,
    );
    await vi.runAllTimersAsync();
    const validated = await pending;
    if (!validated.ok) throw new Error("expected ok");
    expect(validated.ref).toBe("users/leom/lists/best-of-2026");
  });

  it("rejects a boxd.it link that is not a list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://letterboxd.com/film/harakiri/" },
          }),
        ),
      ),
    );
    await expect(
      letterboxdProvider.validateSource("lbxshort/film1", context),
    ).rejects.toMatchObject({ reason: "not_found" });
  });
});

describe("Letterboxd member collections and charts", () => {
  it.each([
    ["users/alice/films", "https://letterboxd.com/alice/films/"],
    // Letterboxd's own form of the range, as in its pagination links.
    [
      "users/alice/films/rated/4.0-5.0",
      "https://letterboxd.com/alice/films/rated/4-5/",
    ],
    ["users/alice/likes/films", "https://letterboxd.com/alice/likes/films/"],
  ])("reads %s from %s in page order", async (sourceRef, url) => {
    const fetch = vi.fn((requested: string) => {
      expect(requested).toBe(url);
      return Promise.resolve(new Response(page([2, 1])));
    });
    vi.stubGlobal("fetch", fetch);
    const result = await letterboxdProvider.fetchSource(sourceRef, context);
    expect(result.complete).toBe(true);
    // No reversal: these keep the page order (unlike a watchlist).
    expect(
      result.entries.map((entry) => entry.externalIds?.letterboxd?.uid),
    ).toEqual(["film:2", "film:1"]);
    expect(result.entries.every((entry) => entry.addedAt === undefined)).toBe(
      true,
    );
  });
});

describe("Letterboxd live page shapes", () => {
  it("never reads the popular charts, which robots.txt disallows", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      letterboxdProvider.fetchSource("films/popular/this/week", context),
    ).rejects.toMatchObject({ reason: "not_found" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads an empty watchlist as empty, not as a failed read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            `<html><head><title>alice's Watchlist • Letterboxd</title></head><body><main id="content"><h1 class="section-heading">alice wants to see 0 films</h1><section class="empty-text body-text -small"><h2 class="ui-block-heading">No films yet</h2></section></main></body></html>`,
          ),
        ),
      ),
    );
    const result = await letterboxdProvider.fetchSource(ref, context);
    expect(result).toEqual({ complete: true, entries: [] });
    await vi.advanceTimersByTimeAsync(0);
    // A valid empty page is not a failed read.
    expect(gate()).toMatchObject({ windowFailures: 0, windowRequests: 1 });
  });

  it("follows a rating filter's pages in Letterboxd's form of the range", async () => {
    const fetch = vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          url.endsWith("/page/2/")
            ? page([2])
            : page([1], "/alice/films/rated/4-5/page/2/"),
        ),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const pending = letterboxdProvider.fetchSource(
      "users/alice/films/rated/4.0-5.0",
      context,
    );
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.complete).toBe(true);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
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
    const fetch = vi.fn((url: string) => {
      expect(url).toBe("https://letterboxd.com/alice/diary/");
      return Promise.resolve(
        new Response(
          diaryPage([
            { id: 1, date: "2026-01-10" },
            { id: 2, date: "2026-03-05" },
            { id: 1, date: "2026-05-20" }, // a rewatch of film 1
          ]),
        ),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const result = await letterboxdProvider.fetchSource(
      "users/alice/diary",
      context,
    );
    expect(result.complete).toBe(true);
    // film 1 appears once, with its most recent date (2026-05-20), so the order
    // oldest-first is film 2 (03-05) then film 1 (05-20).
    expect(
      result.entries.map((entry) => entry.externalIds?.letterboxd?.uid),
    ).toEqual(["film:2", "film:1"]);
    expect(result.entries.map((entry) => entry.addedAt)).toEqual([
      "2026-03-05T00:00:00.000Z",
      "2026-05-20T00:00:00.000Z",
    ]);
  });

  it("reads rewatch pages that list the same films on different dates", async () => {
    const fetch = vi.fn((url: string) => {
      if (url === "https://letterboxd.com/alice/diary/")
        return Promise.resolve(
          new Response(
            diaryPage(
              [
                { id: 1, date: "2026-05-20" },
                { id: 2, date: "2026-05-19" },
              ],
              "/alice/diary/page/2/",
            ),
          ),
        );
      expect(url).toBe("https://letterboxd.com/alice/diary/page/2/");
      return Promise.resolve(
        new Response(
          diaryPage([
            { id: 1, date: "2026-01-10" },
            { id: 2, date: "2026-01-09" },
          ]),
        ),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const pending = letterboxdProvider.fetchSource(
      "users/alice/diary",
      context,
    );
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.complete).toBe(true);
    expect(result.entries.map((entry) => entry.addedAt)).toEqual([
      "2026-05-19T00:00:00.000Z",
      "2026-05-20T00:00:00.000Z",
    ]);
  });

  it("refuses an unrelated complete page as an empty diary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            "<html><head><title>Something • Letterboxd</title></head><body><h1>Something</h1></body></html>",
          ),
        ),
      ),
    );
    await expect(
      letterboxdProvider.fetchSource("users/alice/diary", context),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("accepts an empty diary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(diaryPage([])))),
    );
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
  beforeEach(() =>
    vi.stubEnv("BETTERSTACK_HEARTBEAT_URL_LETTERBOXD", heartbeat),
  );

  it("reports the halt to Better Stack once, when the shared state flips", async () => {
    const pings: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.startsWith(heartbeat)) {
          pings.push(url);
          return Promise.resolve(new Response("ok"));
        }
        return Promise.resolve(new Response("refused", { status: 403 }));
      }),
    );
    await expect(
      letterboxdProvider.fetchSource(ref, context),
    ).rejects.toMatchObject({ reason: "unavailable" });
    // A later read is refused by the halt itself and does not report again.
    await expect(
      letterboxdProvider.fetchSource("users/bob/watchlist", context),
    ).rejects.toMatchObject({ reason: "disabled" });
    expect(pings).toEqual([`${heartbeat}/fail`]);
    expect(gate().haltedAt).not.toBeNull();
  });
  it("reports the recovery when a probe works after 30 minutes", async () => {
    const pings: string[] = [];
    let refuse = true;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.startsWith(heartbeat)) {
          pings.push(url);
          return Promise.resolve(new Response("ok"));
        }
        return Promise.resolve(
          refuse
            ? new Response("refused", { status: 403 })
            : new Response(page([1])),
        );
      }),
    );
    await expect(
      letterboxdProvider.fetchSource(ref, context),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    refuse = false;
    const read = letterboxdProvider.fetchSource("users/bob/watchlist", context);
    await vi.runAllTimersAsync();
    expect((await read).entries).toHaveLength(1);
    expect(pings).toEqual([`${heartbeat}/fail`, heartbeat]);
    expect(gate()).toMatchObject({ haltedAt: null, rate: 0.33 });
  });

  it("does not report a successful read", async () => {
    const send = vi.fn((url: string) => {
      expect(url.startsWith(heartbeat)).toBe(false);
      return Promise.resolve(new Response(page([1])));
    });
    vi.stubGlobal("fetch", send);
    await letterboxdProvider.fetchSource(ref, context);
    await vi.advanceTimersByTimeAsync(0);
    expect(gate().haltedAt).toBeNull();
  });
});

describe("Letterboxd request log", () => {
  const kept = () => db.getTable("letterboxd_requests");
  const counted = () => db.getTable("letterboxd_request_counts");

  it("keeps a refused request in full, with its Cloudflare headers and body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("<html>Sorry, you have been blocked</html>", {
            status: 403,
            headers: { "cf-mitigated": "challenge", "cf-ray": "abc-FRA" },
          }),
        ),
      ),
    );
    await expect(
      letterboxdProvider.fetchSource(ref, context),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await vi.advanceTimersByTimeAsync(0);
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
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(page([1])))),
    );
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    await letterboxdProvider.fetchSource(ref, context);
    await vi.advanceTimersByTimeAsync(0);
    expect(counted()).toHaveLength(1);
    expect(kept()).toHaveLength(0);

    random.mockReturnValue(0.001);
    await letterboxdProvider.fetchSource("users/bob/watchlist", context);
    await vi.advanceTimersByTimeAsync(0);
    expect(kept()).toEqual([
      expect.objectContaining({
        outcome: "ok",
        status: 200,
        body_excerpt: null,
      }),
    ]);
    expect(kept()[0].bytes).toBeGreaterThan(0);
  });
  it("reports a refusal to the gate at once, even when its body stalls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("<html>Blocked"));
              },
            }),
            { status: 403 },
          ),
        ),
      ),
    );
    await expect(
      letterboxdProvider.fetchSource(ref, context),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await vi.advanceTimersByTimeAsync(0);
    expect(gate().haltReason).toBe("blocked");
    expect(kept()).toHaveLength(0);
    // The log waits 3 s for the body, then keeps what arrived.
    await vi.advanceTimersByTimeAsync(3000);
    expect(kept()).toEqual([
      expect.objectContaining({
        outcome: "blocked",
        body_excerpt: "<html>Blocked",
      }),
    ]);
  });
  it("keeps the first bytes of a body that breaks while it is read", async () => {
    let sent = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              // The first read gets bytes, the next one breaks.
              pull(controller) {
                if (sent) controller.error(new Error("connection reset"));
                else
                  controller.enqueue(new TextEncoder().encode("<html><head>"));
                sent = true;
              },
            }),
          ),
        ),
      ),
    );
    await expect(
      letterboxdProvider.fetchSource(ref, context),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await vi.advanceTimersByTimeAsync(0);
    expect(kept()).toEqual([
      expect.objectContaining({
        outcome: "failed",
        body_excerpt: "<html><head>",
      }),
    ]);
  });
  it("keeps a network error with no status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed"))),
    );
    await expect(
      letterboxdProvider.fetchSource(ref, context),
    ).rejects.toMatchObject({ reason: "unavailable" });
    await vi.advanceTimersByTimeAsync(0);
    expect(kept()).toEqual([
      expect.objectContaining({
        outcome: "failed",
        status: null,
        error: expect.stringContaining("fetch failed") as unknown,
      }),
    ]);
  });
});
