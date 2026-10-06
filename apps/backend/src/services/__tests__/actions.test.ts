import type { ActionKind, ProviderId } from "@stremlist/shared/providers";
import { beforeEach, describe, expect, it, vi } from "vitest";

const backgroundMocks = vi.hoisted(() => ({
  scheduleBackgroundTask: vi.fn(),
}));

vi.mock("../../lib/supabase", async () => {
  return await import("../../__tests__/helpers/mock-supabase");
});
vi.mock("../../lib/r2", async () => {
  return await import("../../__tests__/helpers/mock-r2");
});
vi.mock("../../lib/background", () => backgroundMocks);
vi.mock("../list-cache", async () => {
  return await import("../../__tests__/helpers/mock-list-cache");
});
vi.mock("../../providers/registry", async () => {
  return await import("../../__tests__/helpers/mock-registry");
});

import {
  movie,
  seedAccount,
  seedConnection,
  seedList,
} from "../../__tests__/helpers/fixtures";
import { cache } from "../../__tests__/helpers/mock-list-cache";
import { r2Objects } from "../../__tests__/helpers/mock-r2";
import {
  fakeActions,
  fakeAdapter,
  resetProviders,
  useFakeProvider,
} from "../../__tests__/helpers/mock-registry";
import { db, resetRpc } from "../../__tests__/helpers/mock-supabase";
import type { Membership, ProviderActions } from "../../providers/types";
import type { Account } from "../accounts";
import { resolveAccountKey } from "../accounts";
import {
  actionProviders,
  buildActionStreams,
  currentRatings,
  parseStreamId,
  performAction,
} from "../actions";

const MOVIE = "tt0111161";
const SERIES = "tt0903747";

const link = (kind: ActionKind, op: string) => `${kind}/${op}`;

function membership(overrides: Partial<Membership> = {}): Membership {
  return {
    watchlist: [],
    watched: [],
    watchedEpisodes: [],
    ratings: {},
    ...overrides,
  };
}

function membershipKey(accountId: string, provider: ProviderId): string {
  return `connections/${accountId}/${provider}/membership.json`;
}

function seedMembership(
  accountId: string,
  provider: ProviderId,
  value: Membership,
  fetchedAt = new Date(),
): void {
  r2Objects.set(
    membershipKey(accountId, provider),
    JSON.stringify({ fetchedAt: fetchedAt.toISOString(), membership: value }),
  );
}

function storedMembership(accountId: string, provider: ProviderId) {
  const raw = r2Objects.get(membershipKey(accountId, provider));
  return raw
    ? (JSON.parse(raw) as { membership: Membership }).membership
    : null;
}

const actionsByProvider = new Map<ProviderId, ProviderActions>();
const performMocks = new Map<ProviderId, ReturnType<typeof vi.fn>>();

function performOf(id: ProviderId) {
  return performMocks.get(id);
}

function useActionProvider(
  id: ProviderId,
  overrides: Partial<ProviderActions> = {},
): ProviderActions {
  const perform = vi.fn(overrides.perform ?? (() => Promise.resolve()));
  performMocks.set(id, perform);
  const actions = fakeActions({
    getMembership: () => Promise.resolve(membership()),
    ...overrides,
    perform,
  });
  actionsByProvider.set(id, actions);
  useFakeProvider(fakeAdapter(id, { actions }));
  return actions;
}

/**
 * A private Account with Actions on for the given Providers, each connected
 * and with the given membership. Every call creates a new Account ID, so the
 * module's in-memory membership never leaks between tests.
 */
async function setup(
  providers: Partial<Record<ProviderId, Membership>>,
  options: { enabled?: boolean; order?: ProviderId[] } = {},
): Promise<Account> {
  const ids = options.order ?? (Object.keys(providers) as ProviderId[]);
  const row = seedAccount({
    actions_enabled: options.enabled ?? true,
    action_providers: ids,
  });
  for (const id of ids) {
    if (!actionsByProvider.has(id)) useActionProvider(id);
    seedConnection(row.id, id);
    const value = providers[id];
    if (value) seedMembership(row.id, id, value);
  }
  const access = await resolveAccountKey(row.id);
  if (!access) throw new Error("account missing");
  return access.account;
}

function titles(streams: { title?: string; externalUrl?: string }[]) {
  return streams.map((stream) => [stream.title, stream.externalUrl]);
}

beforeEach(() => {
  db.reset();
  resetRpc();
  cache.reset();
  r2Objects.clear();
  resetProviders();
  actionsByProvider.clear();
  performMocks.clear();
  backgroundMocks.scheduleBackgroundTask.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("parseStreamId", () => {
  it.each([
    ["movie", MOVIE, { imdbId: MOVIE, type: "movie" }],
    ["series", SERIES, { imdbId: SERIES, type: "series" }],
    [
      "series",
      `${SERIES}:2:5`,
      { imdbId: SERIES, type: "series", episode: { season: 2, episode: 5 } },
    ],
    ["movie", `${MOVIE}:2:5`, { imdbId: MOVIE, type: "movie" }],
    ["series", `${SERIES}:x:5`, { imdbId: SERIES, type: "series" }],
    ["movie", "kitsu:123", null],
    ["movie", "tmdb:550", null],
  ] as const)("%s %s", (type, id, expected) => {
    expect(parseStreamId(type, id)).toEqual(expected);
  });
});

describe("actionProviders", () => {
  it("keeps the user's order and drops Providers that cannot act now", async () => {
    useActionProvider("trakt");
    useActionProvider("simkl");
    useFakeProvider(fakeAdapter("mdblist"));
    const row = seedAccount({
      actions_enabled: true,
      action_providers: ["simkl", "mdblist", "imdb", "trakt"],
    });
    seedConnection(row.id, "trakt");
    seedConnection(row.id, "simkl");
    seedConnection(row.id, "mdblist");
    const account = (await resolveAccountKey(row.id))?.account;
    if (!account) throw new Error("account missing");

    // mdblist has no Actions here; imdb has no Connection.
    expect(await actionProviders(account)).toEqual(["simkl", "trakt"]);

    process.env.DISABLED_PROVIDERS = "simkl";
    expect(await actionProviders(account)).toEqual(["trakt"]);
  });

  it("returns nothing when Actions are off", async () => {
    const account = await setup({ trakt: membership() }, { enabled: false });
    expect(await actionProviders(account)).toEqual([]);
  });
});

describe("buildActionStreams", () => {
  it("offers to add, mark and rate when one Provider has nothing", async () => {
    const account = await setup({ trakt: membership() });

    const streams = await buildActionStreams(
      account,
      { imdbId: MOVIE, type: "movie" },
      link,
    );

    expect(titles(streams)).toEqual([
      ["🔖 Add to Trakt watchlist", "watchlist/add"],
      ["✅ Mark as watched on Trakt", "watched/add"],
      ["⭐ Rate on Trakt", "rating/rate"],
    ]);
    expect(streams.every((stream) => stream.name === "Stremlist")).toBe(true);
    // Every entry opens a page; none is playable (ADR 0003).
    expect(streams.every((stream) => !("url" in stream))).toBe(true);
    expect(streams.every((stream) => !stream.behaviorHints)).toBe(true);
  });

  it("offers to undo when one Provider has everything", async () => {
    const account = await setup({
      trakt: membership({
        watchlist: [MOVIE],
        watched: [MOVIE],
        ratings: { [MOVIE]: 8 },
      }),
    });

    const streams = await buildActionStreams(
      account,
      { imdbId: MOVIE, type: "movie" },
      link,
    );

    expect(titles(streams)).toEqual([
      ["🔖 In your Trakt watchlist\nSelect to remove", "watchlist/remove"],
      ["✅ Watched on Trakt\nSelect to mark as unwatched", "watched/remove"],
      ["⭐ Rated 8/10, change\nTrakt", "rating/rate"],
    ]);
  });

  it("uses one entry per slot when several Providers agree (none)", async () => {
    const account = await setup({
      trakt: membership(),
      simkl: membership(),
    });

    const streams = await buildActionStreams(
      account,
      { imdbId: MOVIE, type: "movie" },
      link,
    );

    expect(titles(streams)).toEqual([
      ["🔖 Add to watchlist\nTrakt, Simkl", "watchlist/add"],
      ["✅ Mark as watched\nTrakt, Simkl", "watched/add"],
      ["⭐ Rate\n1 to 10, on Trakt, Simkl", "rating/rate"],
    ]);
  });

  it("uses one entry per slot when several Providers agree (all)", async () => {
    const all = membership({
      watchlist: [MOVIE],
      watched: [MOVIE],
      ratings: { [MOVIE]: 7 },
    });
    const account = await setup({ trakt: all, simkl: all });

    const streams = await buildActionStreams(
      account,
      { imdbId: MOVIE, type: "movie" },
      link,
    );

    expect(titles(streams)).toEqual([
      [
        "🔖 In watchlist on Trakt, Simkl\nSelect to remove from all",
        "watchlist/remove",
      ],
      [
        "✅ Watched on Trakt, Simkl\nSelect to mark as unwatched everywhere",
        "watched/remove",
      ],
      ["⭐ Rated 7/10, change\nTrakt, Simkl", "rating/rate"],
    ]);
  });

  it("splits a slot in two when the Providers differ", async () => {
    const account = await setup({
      trakt: membership({ watchlist: [MOVIE], ratings: { [MOVIE]: 7 } }),
      simkl: membership({ watched: [MOVIE], ratings: { [MOVIE]: 9 } }),
    });

    const streams = await buildActionStreams(
      account,
      { imdbId: MOVIE, type: "movie" },
      link,
    );

    expect(titles(streams)).toEqual([
      ["🔖 Add to watchlist\nSimkl (already on Trakt)", "watchlist/add"],
      ["🔖 Remove from watchlist\nTrakt", "watchlist/remove"],
      ["✅ Mark as watched\nTrakt (already watched on Simkl)", "watched/add"],
      ["✅ Mark as unwatched\nSimkl", "watched/remove"],
      ["⭐ 7/10 on Trakt, 9/10 on Simkl, change", "rating/rate"],
    ]);
  });

  it("follows the user's Provider order", async () => {
    const account = await setup(
      { trakt: membership(), simkl: membership() },
      { order: ["simkl", "trakt"] },
    );

    const streams = await buildActionStreams(
      account,
      { imdbId: MOVIE, type: "movie" },
      link,
    );

    expect(streams[0].title).toBe("🔖 Add to watchlist\nSimkl, Trakt");
  });

  it("names the episode for a series episode", async () => {
    const account = await setup({ trakt: membership() });
    const target = parseStreamId("series", `${SERIES}:2:5`);
    if (!target) throw new Error("bad stream id");

    const streams = await buildActionStreams(account, target, link);

    expect(titles(streams)).toEqual([
      ["🔖 Add to Trakt watchlist", "watchlist/add"],
      ["✅ Mark S02E05 as watched on Trakt", "watched/add"],
      ["⭐ Rate series on Trakt", "rating/rate"],
    ]);
  });

  it("knows which episodes are watched", async () => {
    const account = await setup({
      trakt: membership({
        watched: [SERIES],
        watchedEpisodes: [`${SERIES}:2:5`],
      }),
    });

    const fifth = await buildActionStreams(
      account,
      { imdbId: SERIES, type: "series", episode: { season: 2, episode: 5 } },
      link,
    );
    const sixth = await buildActionStreams(
      account,
      { imdbId: SERIES, type: "series", episode: { season: 2, episode: 6 } },
      link,
    );

    expect(fifth[1].title).toBe(
      "✅ S02E05 watched on Trakt\nSelect to mark as unwatched",
    );
    expect(sixth[1].title).toBe("✅ Mark S02E06 as watched on Trakt");
  });

  it("only shows the kinds of Action each Provider supports", async () => {
    useActionProvider("trakt", { kinds: ["watchlist"] });
    const account = await setup({ trakt: membership() });

    const streams = await buildActionStreams(
      account,
      { imdbId: MOVIE, type: "movie" },
      link,
    );

    expect(titles(streams)).toEqual([
      ["🔖 Add to Trakt watchlist", "watchlist/add"],
    ]);
  });

  it("returns nothing when Actions are off", async () => {
    const account = await setup({ trakt: membership() }, { enabled: false });

    await expect(
      buildActionStreams(account, { imdbId: MOVIE, type: "movie" }, link),
    ).resolves.toEqual([]);
  });

  it("never waits for the Provider: stale membership refreshes in the background", async () => {
    const getMembership = vi.fn(() =>
      Promise.resolve(membership({ watchlist: [MOVIE] })),
    );
    useActionProvider("trakt", { getMembership });
    const row = seedAccount({
      actions_enabled: true,
      action_providers: ["trakt"],
    });
    seedConnection(row.id, "trakt");
    seedMembership(
      row.id,
      "trakt",
      membership(),
      new Date(Date.now() - 60 * 60_000),
    );
    const account = (await resolveAccountKey(row.id))?.account;
    if (!account) throw new Error("account missing");

    const streams = await buildActionStreams(
      account,
      { imdbId: MOVIE, type: "movie" },
      link,
    );

    expect(streams[0].title).toBe("🔖 Add to Trakt watchlist");
    expect(getMembership).not.toHaveBeenCalled();
    expect(backgroundMocks.scheduleBackgroundTask).toHaveBeenCalledOnce();

    const [task] = backgroundMocks.scheduleBackgroundTask.mock.calls[0] as [
      () => Promise<void>,
    ];
    await task();
    expect(getMembership).toHaveBeenCalledOnce();
    expect(storedMembership(account.id, "trakt")?.watchlist).toEqual([MOVIE]);

    const after = await buildActionStreams(
      account,
      { imdbId: MOVIE, type: "movie" },
      link,
    );
    expect(after[0].title).toBe("🔖 In your Trakt watchlist\nSelect to remove");
  });

  it("does not refresh fresh membership", async () => {
    const account = await setup({ trakt: membership() });

    await buildActionStreams(account, { imdbId: MOVIE, type: "movie" }, link);

    expect(backgroundMocks.scheduleBackgroundTask).not.toHaveBeenCalled();
  });
});

describe("performAction", () => {
  it("performs the Action, updates membership and marks affected Lists stale", async () => {
    const account = await setup({ trakt: membership(), simkl: membership() });
    const watchlist = seedList(account.id, {
      provider: "trakt",
      source_ref: "me/watchlist",
    });
    const history = seedList(account.id, {
      provider: "trakt",
      source_ref: "me/history",
    });
    const otherProvider = seedList(account.id, {
      provider: "simkl",
      source_ref: "me/watchlist",
    });
    for (const list of [watchlist, history, otherProvider]) {
      cache.seed(list.id, [movie(MOVIE)]);
    }

    const outcomes = await performAction(
      account,
      ["trakt"],
      { kind: "watchlist", add: true },
      { imdbId: MOVIE, type: "movie" },
    );

    expect(outcomes).toEqual([{ provider: "trakt", ok: true }]);
    expect(performOf("trakt")).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "trakt" }),
      { kind: "watchlist", add: true },
      { imdbId: MOVIE, type: "movie" },
    );
    expect(performOf("simkl")).not.toHaveBeenCalled();
    expect(storedMembership(account.id, "trakt")?.watchlist).toEqual([MOVIE]);
    expect(cache.get(watchlist.id)?.cachedAt.getTime()).toBe(0);
    expect(cache.get(history.id)?.cachedAt.getTime()).not.toBe(0);
    expect(cache.get(otherProvider.id)?.cachedAt.getTime()).not.toBe(0);

    const streams = await buildActionStreams(
      account,
      { imdbId: MOVIE, type: "movie" },
      link,
    );
    expect(titles(streams)[0]).toEqual([
      "🔖 Add to watchlist\nSimkl (already on Trakt)",
      "watchlist/add",
    ]);
  });

  it("is idempotent: the same intent twice gives the same membership", async () => {
    const account = await setup({ trakt: membership() });
    const target = { imdbId: MOVIE, type: "movie" } as const;

    await performAction(
      account,
      ["trakt"],
      { kind: "watchlist", add: true },
      target,
    );
    await performAction(
      account,
      ["trakt"],
      { kind: "watchlist", add: true },
      target,
    );

    expect(storedMembership(account.id, "trakt")?.watchlist).toEqual([MOVIE]);

    await performAction(
      account,
      ["trakt"],
      { kind: "watchlist", add: false },
      target,
    );
    expect(storedMembership(account.id, "trakt")?.watchlist).toEqual([]);
  });

  it("records a watched episode and the series it belongs to", async () => {
    const account = await setup({ trakt: membership() });

    await performAction(
      account,
      ["trakt"],
      { kind: "watched", add: true },
      { imdbId: SERIES, type: "series", episode: { season: 1, episode: 2 } },
    );

    expect(storedMembership(account.id, "trakt")).toMatchObject({
      watched: [SERIES],
      watchedEpisodes: [`${SERIES}:1:2`],
    });
  });

  it("sets and removes ratings", async () => {
    const account = await setup({ trakt: membership() });
    const target = { imdbId: MOVIE, type: "movie" } as const;

    await performAction(
      account,
      ["trakt"],
      { kind: "rating", rating: 9 },
      target,
    );
    expect(await currentRatings(account, MOVIE)).toEqual([
      { provider: "trakt", rating: 9 },
    ]);

    await performAction(
      account,
      ["trakt"],
      { kind: "rating", rating: null },
      target,
    );
    expect(await currentRatings(account, MOVIE)).toEqual([
      { provider: "trakt", rating: null },
    ]);
  });

  it("reports each Provider's outcome on its own", async () => {
    useActionProvider("simkl", {
      perform: vi.fn(() => Promise.reject(new Error("Simkl 500"))),
    });
    const account = await setup({ trakt: membership(), simkl: membership() });

    const outcomes = await performAction(
      account,
      ["trakt", "simkl", "mdblist"],
      { kind: "watchlist", add: true },
      { imdbId: MOVIE, type: "movie" },
    );

    expect(outcomes).toEqual([
      { provider: "trakt", ok: true },
      { provider: "simkl", ok: false, error: "provider_error" },
      { provider: "mdblist", ok: false, error: "not_available" },
    ]);
    // A failed Action leaves the membership as it was.
    expect(storedMembership(account.id, "simkl")?.watchlist).toEqual([]);
  });

  it("refuses an Action kind the Provider does not support", async () => {
    useActionProvider("trakt", { kinds: ["watchlist"] });
    const account = await setup({ trakt: membership() });

    const outcomes = await performAction(
      account,
      ["trakt"],
      { kind: "rating", rating: 5 },
      { imdbId: MOVIE, type: "movie" },
    );

    expect(outcomes).toEqual([
      { provider: "trakt", ok: false, error: "not_available" },
    ]);
    expect(performOf("trakt")).not.toHaveBeenCalled();
  });

  it("refuses everything when Actions are off", async () => {
    const account = await setup({ trakt: membership() }, { enabled: false });

    const outcomes = await performAction(
      account,
      ["trakt"],
      { kind: "watchlist", add: true },
      { imdbId: MOVIE, type: "movie" },
    );

    expect(outcomes).toEqual([
      { provider: "trakt", ok: false, error: "not_available" },
    ]);
  });
});
