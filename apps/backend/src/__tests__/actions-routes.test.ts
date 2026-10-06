import type { ProviderId } from "@stremlist/shared/providers";
import type { StremioStream } from "@stremlist/shared/stremio.types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/supabase", async () => {
  return await import("./helpers/mock-supabase.js");
});
vi.mock("../lib/r2", async () => {
  return await import("./helpers/mock-r2.js");
});
vi.mock("../lib/background", () => ({ scheduleBackgroundTask: vi.fn() }));
vi.mock("../services/list-cache", async () => {
  return await import("./helpers/mock-list-cache.js");
});
vi.mock("../providers/registry", async () => {
  return await import("./helpers/mock-registry.js");
});
vi.mock("../lib/resend", () => ({
  resend: { contacts: { create: vi.fn() } },
}));

import app from "../index.js";
import type { Membership, ProviderActions } from "../providers/types";
import {
  seedAccount,
  seedConnection,
  seedLegacyAccount,
} from "./helpers/fixtures.js";
import { r2Objects } from "./helpers/mock-r2.js";
import {
  fakeActions,
  fakeAdapter,
  resetProviders,
  useFakeProvider,
} from "./helpers/mock-registry.js";
import { db, resetRpc } from "./helpers/mock-supabase.js";

const MOVIE = "tt0111161";
const SERIES = "tt0903747";

interface StreamResponse {
  streams: StremioStream[];
  cacheMaxAge: number;
}

const perform = vi.fn<ProviderActions["perform"]>();

function useActionProvider(id: ProviderId, kinds = fakeActions().kinds) {
  useFakeProvider(
    fakeAdapter(id, { actions: fakeActions({ kinds, perform }) }),
  );
}

function seedMembership(
  accountId: string,
  provider: ProviderId,
  membership: Partial<Membership>,
) {
  r2Objects.set(
    `connections/${accountId}/${provider}/membership.json`,
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      membership: {
        watchlist: [],
        watched: [],
        watchedEpisodes: [],
        ratings: {},
        ...membership,
      },
    }),
  );
}

/** A private Account with Actions on Trakt, connected. */
function seedActionAccount(
  overrides: { enabled?: boolean; providers?: ProviderId[] } = {},
) {
  const providers = overrides.providers ?? ["trakt"];
  const account = seedAccount({
    actions_enabled: overrides.enabled ?? true,
    action_providers: providers,
  });
  for (const provider of providers) seedConnection(account.id, provider);
  return account;
}

function postForm(path: string, form: [string, string][]) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

beforeEach(() => {
  db.reset();
  resetRpc();
  r2Objects.clear();
  resetProviders();
  perform.mockReset();
  perform.mockResolvedValue(undefined);
  useActionProvider("trakt");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.BACKEND_PUBLIC_URL;
  vi.restoreAllMocks();
});

describe("GET /:accountKey/stream/:type/:id.json", () => {
  it("returns Action entries that open Stremlist pages, never cached", async () => {
    const account = seedActionAccount();

    const res = await app.request(`/${account.id}/stream/movie/${MOVIE}.json`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as StreamResponse;
    expect(body.cacheMaxAge).toBe(0);
    expect(body.streams.map((stream) => stream.externalUrl)).toEqual([
      `http://localhost/${account.id}/actions/watchlist/add/movie/${MOVIE}`,
      `http://localhost/${account.id}/actions/watched/add/movie/${MOVIE}`,
      `http://localhost/${account.id}/actions/rating/rate/movie/${MOVIE}`,
    ]);
    for (const stream of body.streams) {
      expect(stream).not.toHaveProperty("url");
      expect(stream).not.toHaveProperty("behaviorHints");
    }
  });

  it("keeps the episode in the Action link and uses the public origin", async () => {
    process.env.BACKEND_PUBLIC_URL = "https://api.stremlist.test/";
    const account = seedActionAccount();

    const res = await app.request(
      `/${account.id}/stream/series/${SERIES}:2:5.json`,
    );

    const body = (await res.json()) as StreamResponse;
    expect(body.streams[1]).toMatchObject({
      title: "✅ Mark S02E05 as watched on Trakt",
      externalUrl: `https://api.stremlist.test/${account.id}/actions/watched/add/series/${SERIES}%3A2%3A5`,
    });
  });

  it("returns nothing through a Legacy alias, even with Actions on", async () => {
    const legacy = seedLegacyAccount("ur12345678", {
      actions_enabled: true,
      action_providers: ["trakt"],
    });
    seedConnection(legacy.id, "trakt");

    const res = await app.request(`/ur12345678/stream/movie/${MOVIE}.json`);

    expect(await res.json()).toEqual({ streams: [], cacheMaxAge: 0 });
  });

  it("returns nothing when Actions are off", async () => {
    const account = seedActionAccount({ enabled: false });

    const res = await app.request(`/${account.id}/stream/movie/${MOVIE}.json`);

    expect(await res.json()).toEqual({ streams: [], cacheMaxAge: 0 });
  });

  it.each([`movie/kitsu:1.json`, `channel/${MOVIE}.json`])(
    "returns nothing for %s",
    async (path) => {
      const account = seedActionAccount();

      const res = await app.request(`/${account.id}/stream/${path}`);

      expect(await res.json()).toEqual({ streams: [], cacheMaxAge: 0 });
    },
  );

  it("returns nothing for an unknown Addon URL", async () => {
    const res = await app.request(
      `/sl_0000000000000000000000/stream/movie/${MOVIE}.json`,
    );

    expect(await res.json()).toEqual({ streams: [], cacheMaxAge: 0 });
  });
});

describe("Action pages", () => {
  it("adds to the watchlist and shows the result", async () => {
    const account = seedActionAccount();

    const res = await app.request(
      `/${account.id}/actions/watchlist/add/movie/${MOVIE}`,
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Added to your watchlist on Trakt");
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(perform).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ provider: "trakt" }),
      { kind: "watchlist", add: true },
      { imdbId: MOVIE, type: "movie" },
    );
  });

  it("removes from the watchlist", async () => {
    const account = seedActionAccount();

    const res = await app.request(
      `/${account.id}/actions/watchlist/remove/movie/${MOVIE}`,
    );

    expect(await res.text()).toContain("Removed from your watchlist on Trakt");
    expect(perform.mock.calls[0][1]).toEqual({ kind: "watchlist", add: false });
  });

  it("adds the whole series to the watchlist from an episode", async () => {
    const account = seedActionAccount();

    await app.request(
      `/${account.id}/actions/watchlist/add/series/${SERIES}%3A2%3A5`,
    );

    expect(perform.mock.calls[0][2]).toEqual({
      imdbId: SERIES,
      type: "series",
    });
  });

  it("marks one episode as watched", async () => {
    const account = seedActionAccount();

    const res = await app.request(
      `/${account.id}/actions/watched/add/series/${SERIES}%3A2%3A5`,
    );

    expect(await res.text()).toContain("S02E05 marked as watched on Trakt");
    expect(perform.mock.calls[0].slice(1)).toEqual([
      { kind: "watched", add: true },
      { imdbId: SERIES, type: "series", episode: { season: 2, episode: 5 } },
    ]);
  });

  it("says which Provider failed", async () => {
    perform.mockRejectedValue(new Error("Trakt 502"));
    const account = seedActionAccount();

    const res = await app.request(
      `/${account.id}/actions/watched/remove/movie/${MOVIE}`,
    );

    const html = await res.text();
    expect(html).toContain("Something went wrong");
    expect(html).toContain("It did not work on Trakt.");
  });

  it.each([
    "watchlist/toggle/movie",
    "watchlist/add/channel",
    "delete/add/movie",
  ])("refuses the malformed Action %s", async (path) => {
    const account = seedActionAccount();

    const res = await app.request(`/${account.id}/actions/${path}/${MOVIE}`);

    expect(res.status).toBe(404);
    expect(perform).not.toHaveBeenCalled();
  });

  it("refuses a Legacy alias", async () => {
    const legacy = seedLegacyAccount("ur12345678", {
      actions_enabled: true,
      action_providers: ["trakt"],
    });
    seedConnection(legacy.id, "trakt");

    for (const key of ["ur12345678", legacy.id]) {
      const res = await app.request(
        `/${key}/actions/watchlist/add/movie/${MOVIE}`,
      );
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("This link does not work");
    }
    expect(perform).not.toHaveBeenCalled();
  });

  describe("rating", () => {
    it("shows a form with the current rating and each Provider", async () => {
      useActionProvider("simkl");
      const account = seedActionAccount({ providers: ["trakt", "simkl"] });
      seedMembership(account.id, "trakt", { ratings: { [MOVIE]: 7 } });

      const res = await app.request(
        `/${account.id}/actions/rating/rate/movie/${MOVIE}`,
      );

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Rate this movie");
      expect(html.match(/type="radio"/g)).toHaveLength(10);
      expect(html).toMatch(/value="7"[^>]*checked/);
      expect(html).toContain('value="trakt"');
      expect(html).toContain('value="simkl"');
      expect(html).toContain("Now 7/10");
      expect(html).toContain("Not rated");
      expect(html).toContain("Remove rating");
      expect(perform).not.toHaveBeenCalled();
    });

    it("hides the remove button when nothing is rated", async () => {
      const account = seedActionAccount();

      const html = await (
        await app.request(`/${account.id}/actions/rating/rate/series/${SERIES}`)
      ).text();

      expect(html).toContain("Rate this series");
      expect(html).not.toContain("Remove rating");
    });

    it("answers 404 when no Provider can rate", async () => {
      useActionProvider("trakt", ["watchlist"]);
      const account = seedActionAccount();

      const res = await app.request(
        `/${account.id}/actions/rating/rate/movie/${MOVIE}`,
      );

      expect(res.status).toBe(404);
    });

    it("sends the rating to the chosen Providers only", async () => {
      useActionProvider("simkl");
      const account = seedActionAccount({ providers: ["trakt", "simkl"] });

      const res = await postForm(
        `/${account.id}/actions/rating/rate/movie/${MOVIE}`,
        [
          ["rating", "8"],
          ["providers", "trakt"],
          ["providers", "netflix"],
        ],
      );

      expect(await res.text()).toContain("Rated 8/10 on Trakt");
      expect(perform).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ provider: "trakt" }),
        { kind: "rating", rating: 8 },
        { imdbId: MOVIE, type: "movie" },
      );
    });

    it("removes the rating", async () => {
      const account = seedActionAccount();

      const res = await postForm(
        `/${account.id}/actions/rating/rate/movie/${MOVIE}`,
        [
          ["remove", "1"],
          ["providers", "trakt"],
        ],
      );

      expect(await res.text()).toContain("Rating removed on Trakt");
      expect(perform.mock.calls[0][1]).toEqual({
        kind: "rating",
        rating: null,
      });
    });

    it.each(["0", "11", "7.5", "abc"])(
      "shows the form again for the invalid rating %j",
      async (rating) => {
        const account = seedActionAccount();

        const res = await postForm(
          `/${account.id}/actions/rating/rate/movie/${MOVIE}`,
          [
            ["rating", rating],
            ["providers", "trakt"],
          ],
        );

        expect(await res.text()).toContain("Rate this movie");
        expect(perform).not.toHaveBeenCalled();
      },
    );

    it("refuses a Legacy alias", async () => {
      seedLegacyAccount("ur12345678", {
        actions_enabled: true,
        action_providers: ["trakt"],
      });

      const res = await postForm(
        `/ur12345678/actions/rating/rate/movie/${MOVIE}`,
        [
          ["rating", "8"],
          ["providers", "trakt"],
        ],
      );

      expect(res.status).toBe(404);
      expect(perform).not.toHaveBeenCalled();
    });
  });
});
