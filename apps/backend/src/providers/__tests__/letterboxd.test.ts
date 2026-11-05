import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
vi.mock("../../lib/r2", () => import("../../__tests__/helpers/mock-r2"));
import {
  r2Objects,
  r2Puts,
  r2Unreadable,
} from "../../__tests__/helpers/mock-r2";
import { letterboxdProvider } from "../letterboxd";
import { letterboxdSnapshot, withLetterboxdPermit } from "../letterboxd-cache";
import {
  letterboxdSnapshotSchema,
  parseLetterboxdPage,
} from "../letterboxd-page";

const context = { connection: null };
const ref = "users/alice/watchlist";
const stateSchema = z.object({
  halted: z.boolean().optional(),
  pausedUntil: z.number().optional(),
  snapshot: letterboxdSnapshotSchema.nullable().optional(),
  failures: z.number().optional(),
});
function stored(key: string) {
  return stateSchema.parse(JSON.parse(r2Objects.get(key) ?? "null"));
}
const gateKey = "providers/letterboxd/http-v1.json";
function page(ids: number[], next?: string) {
  return `<html><head><title>Alice's list • Letterboxd</title></head><body><h1>Alice's list</h1><ul class="poster-list -grid">${ids.map((id) => `<li data-postered-identifier='{"uid":"film:${id}"}' data-item-slug="film-${id}" data-item-name="Film ${id} (2000)"></li>`).join("")}</ul>${next ? `<a class="next" href="${next}">Next</a>` : ""}</body></html>`;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-05T18:00:00Z"));
  r2Objects.clear();
  r2Unreadable.clear();
  r2Puts.before = null;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Letterboxd public reads", () => {
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

  it("invalid pagination counts toward the pause and consecutive-failure stop", async () => {
    const send = vi.fn(() =>
      Promise.resolve(new Response(page([1], "/alice/watchlist/"))),
    );
    vi.stubGlobal("fetch", send);
    for (let count = 1; count <= 3; count++) {
      await expect(
        letterboxdProvider.fetchSource(ref, context),
      ).rejects.toMatchObject({ reason: "unavailable" });
      expect(stored(gateKey)).toMatchObject({
        failures: count,
        pausedUntil: Date.now() + 15 * 60_000,
        halted: count === 3,
      });
      await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
    }
    await expect(
      letterboxdProvider.fetchSource(ref, context),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(3);
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
    expect((await pending).entries).toHaveLength(40);
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
      await expect(
        letterboxdProvider.fetchSource("users/bob/watchlist", context),
      ).rejects.toMatchObject({ reason: "unavailable" });
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
  it.each([403, 429])(
    "stops every instance after HTTP %i, with no retry",
    async (status) => {
      const fetch = vi.fn(() =>
        Promise.resolve(new Response("refused", { status })),
      );
      vi.stubGlobal("fetch", fetch);
      await expect(
        letterboxdProvider.fetchSource(ref, context),
      ).rejects.toMatchObject({ reason: "unavailable" });
      await expect(
        letterboxdProvider.fetchSource("users/bob/watchlist", context),
      ).rejects.toMatchObject({ reason: "unavailable" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(stored(gateKey).halted).toBe(true);
    },
  );
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
    const state = stored(gateKey);
    expect(state.halted).toBe(false);
    expect(state.pausedUntil).toBe(Date.now() + 15 * 60_000);
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
  it("does not send if the storage grant returns after its reservation expired", async () => {
    r2Puts.before = (key) => {
      if (key !== gateKey) return;
      r2Puts.before = null;
      vi.setSystemTime(Date.now() + 46_000);
    };
    const read = vi.fn(() =>
      Promise.resolve({ value: true, result: "ok" as const }),
    );
    await expect(withLetterboxdPermit(read)).rejects.toThrow();
    await expect(withLetterboxdPermit(read)).rejects.toThrow();
    expect(stored(gateKey).halted).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
  it("allows one request in flight across concurrent callers and spaces completions", async () => {
    let active = 0;
    let maximum = 0;
    const sent: number[] = [];
    const requests = Array.from({ length: 12 }, () =>
      withLetterboxdPermit(async () => {
        active++;
        maximum = Math.max(maximum, active);
        sent.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 50));
        active--;
        return { value: true, result: "ok" };
      }),
    );
    const pending = Promise.allSettled(requests);
    await vi.runAllTimersAsync();
    await pending;
    expect(maximum).toBe(1);
    expect(sent.length).toBeGreaterThan(1);
    sent.slice(1).forEach((at, index) => {
      expect(at - sent[index]).toBeGreaterThanOrEqual(3000);
    });
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
  it("fails closed on lost storage or an orphaned HTTP reservation", async () => {
    r2Unreadable.add(gateKey);
    const read = vi.fn(() =>
      Promise.resolve({ value: true, result: "ok" as const }),
    );
    await expect(withLetterboxdPermit(read)).rejects.toThrow();
    r2Unreadable.clear();
    r2Objects.set(
      gateKey,
      JSON.stringify({
        activeId: "lost",
        activeUntil: Date.now() - 1,
        nextAt: 0,
        pausedUntil: 0,
        halted: false,
        failures: 0,
      }),
    );
    await expect(withLetterboxdPermit(read)).rejects.toThrow();
    expect(stored(gateKey).halted).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
});
