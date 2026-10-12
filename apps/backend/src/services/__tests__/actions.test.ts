import type { ActionKind, ProviderId } from "@stremlist/shared/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import {
  r2Objects,
  r2Puts,
  r2Unreadable,
} from "../../__tests__/helpers/mock-r2";
import {
  fakeActions,
  fakeAdapter,
  resetProviders,
  useFakeProvider,
} from "../../__tests__/helpers/mock-registry";
import { db, resetRpc } from "../../__tests__/helpers/mock-supabase";
import type {
  ActionIntent,
  ActionTarget,
  Membership,
  ProviderActions,
} from "../../providers/types";
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
const MOVIE_TARGET = { imdbId: MOVIE, type: "movie" } as const;
const ADD_TO_WATCHLIST = { kind: "watchlist", add: true } as const;

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
    JSON.stringify({
      fetchedAt: fetchedAt.toISOString(),
      // The Provider user of the seeded Connections.
      username: "leo",
      membership: value,
    }),
  );
}

function storedMembership(accountId: string, provider: ProviderId) {
  const raw = r2Objects.get(membershipKey(accountId, provider));
  return raw
    ? (JSON.parse(raw) as { membership: Membership }).membership
    : null;
}

const performMocks = new Map<ProviderId, ReturnType<typeof vi.fn>>();

function useActionProvider(
  id: ProviderId,
  overrides: Partial<ProviderActions> = {},
): void {
  const perform = vi.fn(overrides.perform ?? (() => Promise.resolve()));
  performMocks.set(id, perform);
  const actions = fakeActions({
    getMembership: () => Promise.resolve(membership()),
    ...overrides,
    perform,
  });
  useFakeProvider(fakeAdapter(id, { actions }));
}

async function accountOf(id: string): Promise<Account> {
  const access = await resolveAccountKey(id);
  if (!access) throw new Error("account missing");
  return access.account;
}

/**
 * A private Account with Actions on for the given Providers, each connected
 * and with the given membership. Every call creates a new Account ID, so the
 * module's in-memory membership never leaks between tests.
 */
function setup(
  providers: Partial<Record<ProviderId, Membership | null>>,
  options: {
    enabled?: boolean;
    order?: ProviderId[];
    stale?: boolean;
    connectedAs?: string;
  } = {},
): Promise<Account> {
  const ids = options.order ?? (Object.keys(providers) as ProviderId[]);
  const row = seedAccount({
    actions_enabled: options.enabled ?? true,
    action_providers: ids,
  });
  for (const id of ids) {
    if (!performMocks.has(id)) useActionProvider(id);
    seedConnection(row.id, id, { username: options.connectedAs });
    const value = providers[id];
    const fetchedAt = new Date(Date.now() - (options.stale ? 60 * 60_000 : 0));
    if (value) seedMembership(row.id, id, value, fetchedAt);
  }
  return accountOf(row.id);
}

function staleAccount(
  getMembership: ProviderActions["getMembership"],
  stored: Membership | null = membership(),
): Promise<Account> {
  useActionProvider("trakt", { getMembership });
  return setup({ trakt: stored }, { stale: true });
}

/** Run every scheduled task, as the background queue would. */
async function runScheduled(): Promise<void> {
  const tasks = backgroundMocks.scheduleBackgroundTask.mock.calls.map(
    ([task]) => task as () => Promise<void>,
  );
  backgroundMocks.scheduleBackgroundTask.mockClear();
  await Promise.all(tasks.map((task) => task()));
}

const open = (account: Account, target: ActionTarget = MOVIE_TARGET) =>
  buildActionStreams(account, target, link);

const act = (
  account: Account,
  intent: ActionIntent,
  target: ActionTarget = MOVIE_TARGET,
  providers: ProviderId[] = ["trakt"],
) => performAction(account, providers, intent, target);

function titles(streams: { title?: string; externalUrl?: string }[]) {
  return streams.map((stream) => [stream.title, stream.externalUrl]);
}

beforeEach(() => {
  db.reset();
  resetRpc();
  cache.reset();
  r2Objects.clear();
  r2Unreadable.clear();
  r2Puts.before = null;
  resetProviders();
  performMocks.clear();
  backgroundMocks.scheduleBackgroundTask.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
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
    for (const id of ["trakt", "simkl", "mdblist"] as const) {
      seedConnection(row.id, id);
    }
    const account = await accountOf(row.id);

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
    const streams = await open(await setup({ trakt: membership() }));

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

  const all = (rating: number) =>
    membership({
      watchlist: [MOVIE],
      watched: [MOVIE],
      ratings: { [MOVIE]: rating },
    });

  it.each([
    [
      "offers to undo when one Provider has everything",
      { trakt: all(8) },
      [
        ["🔖 In your Trakt watchlist\nSelect to remove", "watchlist/remove"],
        ["✅ Watched on Trakt\nSelect to mark as unwatched", "watched/remove"],
        ["⭐ Rated 8/10, change\nTrakt", "rating/rate"],
      ],
    ],
    [
      "uses one entry per slot when several Providers agree (none)",
      { trakt: membership(), simkl: membership() },
      [
        ["🔖 Add to watchlist\nTrakt and Simkl", "watchlist/add"],
        ["✅ Mark as watched\nTrakt and Simkl", "watched/add"],
        ["⭐ Rate\nFrom 1 to 10 on Trakt and Simkl", "rating/rate"],
      ],
    ],
    [
      "uses one entry per slot when several Providers agree (all)",
      { trakt: all(7), simkl: all(7) },
      [
        [
          "🔖 In watchlist on Trakt and Simkl\nSelect to remove from all",
          "watchlist/remove",
        ],
        [
          "✅ Watched on Trakt and Simkl\nSelect to mark as unwatched everywhere",
          "watched/remove",
        ],
        ["⭐ Rated 7/10, change\nTrakt and Simkl", "rating/rate"],
      ],
    ],
    [
      "says where a Title is not rated yet when only some Providers rated it",
      { trakt: membership({ ratings: { [MOVIE]: 6 } }), simkl: membership() },
      [
        ["🔖 Add to watchlist\nTrakt and Simkl", "watchlist/add"],
        ["✅ Mark as watched\nTrakt and Simkl", "watched/add"],
        ["⭐ 6/10 on Trakt, change\nNot rated on Simkl", "rating/rate"],
      ],
    ],
    [
      "splits a slot in two when the Providers differ",
      {
        trakt: membership({ watchlist: [MOVIE], ratings: { [MOVIE]: 7 } }),
        simkl: membership({ watched: [MOVIE], ratings: { [MOVIE]: 9 } }),
      },
      [
        ["🔖 Add to watchlist\nSimkl (already on Trakt)", "watchlist/add"],
        ["🔖 Remove from watchlist\nTrakt", "watchlist/remove"],
        ["✅ Mark as watched\nTrakt (already watched on Simkl)", "watched/add"],
        ["✅ Mark as unwatched\nSimkl", "watched/remove"],
        ["⭐ 7/10 on Trakt, 9/10 on Simkl, change", "rating/rate"],
      ],
    ],
  ])("%s", async (_, providers, expected) => {
    expect(titles(await open(await setup(providers)))).toEqual(expected);
  });

  it("follows the user's Provider order", async () => {
    const account = await setup(
      { trakt: membership(), simkl: membership() },
      { order: ["simkl", "trakt"] },
    );

    expect((await open(account))[0].title).toBe(
      "🔖 Add to watchlist\nSimkl and Trakt",
    );
  });

  it("names the episode for a series episode", async () => {
    const account = await setup({ trakt: membership() });
    const target = parseStreamId("series", `${SERIES}:2:5`);
    if (!target) throw new Error("bad stream id");

    expect(titles(await open(account, target))).toEqual([
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
    const episode = (number: number) =>
      open(account, {
        imdbId: SERIES,
        type: "series",
        episode: { season: 2, episode: number },
      });

    expect((await episode(5))[1].title).toBe(
      "✅ S02E05 watched on Trakt\nSelect to mark as unwatched",
    );
    expect((await episode(6))[1].title).toBe(
      "✅ Mark S02E06 as watched on Trakt",
    );
  });

  it("only shows the kinds of Action each Provider supports", async () => {
    useActionProvider("trakt", { kinds: ["watchlist"] });
    const account = await setup({ trakt: membership() });

    expect(titles(await open(account))).toEqual([
      ["🔖 Add to Trakt watchlist", "watchlist/add"],
    ]);
  });

  it("returns nothing when Actions are off", async () => {
    const account = await setup({ trakt: membership() }, { enabled: false });

    await expect(open(account)).resolves.toEqual([]);
  });

  it("never waits for the Provider: stale membership refreshes in the background", async () => {
    const getMembership = vi.fn(() =>
      Promise.resolve(membership({ watchlist: [MOVIE] })),
    );
    const account = await staleAccount(getMembership);

    expect((await open(account))[0].title).toBe("🔖 Add to Trakt watchlist");
    expect(getMembership).not.toHaveBeenCalled();
    expect(backgroundMocks.scheduleBackgroundTask).toHaveBeenCalledOnce();

    await runScheduled();
    expect(getMembership).toHaveBeenCalledOnce();
    expect(storedMembership(account.id, "trakt")?.watchlist).toEqual([MOVIE]);
    expect((await open(account))[0].title).toBe(
      "🔖 In your Trakt watchlist\nSelect to remove",
    );
  });

  it("ignores the membership of the previous Provider user", async () => {
    // Connected again as another Trakt user: the stored membership is fresh,
    // but it is the previous user's.
    const account = await setup(
      { trakt: membership({ watchlist: [MOVIE] }) },
      { connectedAs: "other" },
    );

    expect((await open(account))[0].title).toBe("🔖 Add to Trakt watchlist");
    expect(backgroundMocks.scheduleBackgroundTask).toHaveBeenCalledOnce();
  });

  it("does not refresh fresh membership", async () => {
    await open(await setup({ trakt: membership() }));

    expect(backgroundMocks.scheduleBackgroundTask).not.toHaveBeenCalled();
  });
});

describe("background membership refresh", () => {
  it("runs one refresh for many concurrent stream requests", async () => {
    const snapshot = Promise.withResolvers<Membership>();
    const getMembership = vi.fn(() => snapshot.promise);
    const account = await staleAccount(getMembership);

    await Promise.all(Array.from({ length: 20 }, () => open(account)));
    expect(backgroundMocks.scheduleBackgroundTask).toHaveBeenCalledOnce();

    const running = runScheduled();
    // While the refresh is in flight, later requests join it.
    await Promise.all(Array.from({ length: 5 }, () => open(account)));
    expect(backgroundMocks.scheduleBackgroundTask).not.toHaveBeenCalled();

    snapshot.resolve(membership({ watchlist: [MOVIE] }));
    await running;
    expect(getMembership).toHaveBeenCalledOnce();
    expect(storedMembership(account.id, "trakt")?.watchlist).toEqual([MOVIE]);
  });

  it.each([{ watchlist: [] }, { watchlist: [MOVIE] }])(
    "discards a background snapshot overtaken by an Action ($watchlist)",
    async ({ watchlist }) => {
      const started = Promise.withResolvers<undefined>();
      const snapshot = Promise.withResolvers<Membership>();
      const account = await staleAccount(() => {
        started.resolve(undefined);
        return snapshot.promise;
      }, membership({ watchlist }));
      await open(account);
      const refreshing = runScheduled();
      await started.promise;
      await act(account, ADD_TO_WATCHLIST);
      snapshot.resolve(membership());
      await refreshing;
      expect(storedMembership(account.id, "trakt")?.watchlist).toEqual([MOVIE]);
      expect((await open(account))[0].title).toContain(
        "In your Trakt watchlist",
      );
    },
  );

  it("waits for a cooldown after a failed refresh, and logs once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const getMembership = vi.fn(() =>
      Promise.reject(new Error("Trakt is down")),
    );
    const account = await staleAccount(getMembership);

    await open(account);
    await runScheduled();
    expect(getMembership).toHaveBeenCalledOnce();

    for (let i = 0; i < 10; i++) await open(account);
    expect(backgroundMocks.scheduleBackgroundTask).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledOnce();

    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await open(account);
    expect(backgroundMocks.scheduleBackgroundTask).toHaveBeenCalledOnce();
  });

  it("remembers a missing membership for a while, then reads R2 again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const account = await staleAccount(
      () => Promise.reject(new Error("Trakt is down")),
      null,
    );

    expect((await open(account))[0].title).toBe("🔖 Add to Trakt watchlist");
    await runScheduled();

    // Another instance writes the membership: this one sees it only after
    // its copy (here, of the absence) expires.
    seedMembership(account.id, "trakt", membership({ watchlist: [MOVIE] }));
    expect((await open(account))[0].title).toBe("🔖 Add to Trakt watchlist");

    vi.setSystemTime(Date.now() + 60_000 + 1);
    expect((await open(account))[0].title).toBe(
      "🔖 In your Trakt watchlist\nSelect to remove",
    );
  });

  it("writes an Action on top of what another instance stored", async () => {
    const account = await setup({ trakt: membership() });
    // Read once, so this instance has its own copy.
    await open(account);
    seedMembership(account.id, "trakt", membership({ watched: [MOVIE] }));

    await act(account, ADD_TO_WATCHLIST);

    expect(storedMembership(account.id, "trakt")).toEqual(
      membership({ watchlist: [MOVIE], watched: [MOVIE] }),
    );
  });
});

describe("performAction", () => {
  it.each([true, false])(
    "merges concurrent successful Actions with an existing cache: %s",
    async (seeded) => {
      const account = await setup({ trakt: membership() });
      if (!seeded) r2Objects.delete(membershipKey(account.id, "trakt"));
      const outcomes = await Promise.all([
        act(account, ADD_TO_WATCHLIST),
        act(
          account,
          { kind: "rating", rating: 8 },
          { imdbId: SERIES, type: "series" },
        ),
      ]);
      expect(outcomes.flat().every((result) => result.ok)).toBe(true);
      expect(storedMembership(account.id, "trakt")).toEqual(
        membership({ watchlist: [MOVIE], ratings: { [SERIES]: 8 } }),
      );
    },
  );

  it("does not overwrite R2 from a memory fallback when the fresh read fails", async () => {
    const account = await setup({ trakt: membership() });
    await open(account);
    seedMembership(account.id, "trakt", membership({ watched: [SERIES] }));
    r2Unreadable.add(membershipKey(account.id, "trakt"));
    const result = await act(account, ADD_TO_WATCHLIST);
    expect(result[0].ok).toBe(true);
    expect(storedMembership(account.id, "trakt")).toEqual(
      membership({ watched: [SERIES] }),
    );
  });

  it("performs the Action, updates membership and marks affected Lists stale", async () => {
    const account = await setup({ trakt: membership(), simkl: membership() });
    const [watchlist, history, otherProvider] = (
      [
        ["trakt", "me/watchlist"],
        ["trakt", "me/history"],
        ["simkl", "me/watchlist"],
      ] as const
    ).map(([provider, source_ref]) => {
      const list = seedList(account.id, { provider, source_ref });
      cache.seed(list.id, [movie(MOVIE)]);
      return list;
    });

    expect(await act(account, ADD_TO_WATCHLIST)).toEqual([
      { provider: "trakt", ok: true },
    ]);
    expect(performMocks.get("trakt")).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "trakt" }),
      ADD_TO_WATCHLIST,
      MOVIE_TARGET,
    );
    expect(performMocks.get("simkl")).not.toHaveBeenCalled();
    expect(storedMembership(account.id, "trakt")?.watchlist).toEqual([MOVIE]);
    expect(cache.get(watchlist.id)?.cachedAt.getTime()).toBe(0);
    expect(cache.get(history.id)?.cachedAt.getTime()).not.toBe(0);
    expect(cache.get(otherProvider.id)?.cachedAt.getTime()).not.toBe(0);
    expect(titles(await open(account))[0]).toEqual([
      "🔖 Add to watchlist\nSimkl (already on Trakt)",
      "watchlist/add",
    ]);
  });

  it("is idempotent: the same intent twice gives the same membership", async () => {
    const account = await setup({ trakt: membership() });

    await act(account, ADD_TO_WATCHLIST);
    await act(account, ADD_TO_WATCHLIST);
    expect(storedMembership(account.id, "trakt")?.watchlist).toEqual([MOVIE]);

    await act(account, { kind: "watchlist", add: false });
    expect(storedMembership(account.id, "trakt")?.watchlist).toEqual([]);
  });

  it("records a watched episode and the series it belongs to", async () => {
    const account = await setup({ trakt: membership() });

    await act(
      account,
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

    for (const rating of [9, null] as const) {
      await act(account, { kind: "rating", rating });
      expect(await currentRatings(account, MOVIE)).toEqual([
        { provider: "trakt", rating },
      ]);
    }
  });

  it("reports each Provider's outcome on its own", async () => {
    useActionProvider("simkl", {
      perform: () => Promise.reject(new Error("Simkl 500")),
    });
    const account = await setup({ trakt: membership(), simkl: membership() });

    expect(
      await act(account, ADD_TO_WATCHLIST, MOVIE_TARGET, [
        "trakt",
        "simkl",
        "mdblist",
      ]),
    ).toEqual([
      { provider: "trakt", ok: true },
      { provider: "simkl", ok: false, error: "provider_error" },
      { provider: "mdblist", ok: false, error: "not_available" },
    ]);
    // A failed Action leaves the membership as it was.
    expect(storedMembership(account.id, "simkl")?.watchlist).toEqual([]);
  });

  it.each<[string, ActionKind[] | undefined, boolean, ActionIntent]>([
    [
      "an Action kind the Provider does not support",
      ["watchlist"],
      true,
      { kind: "rating", rating: 5 },
    ],
    ["everything when Actions are off", undefined, false, ADD_TO_WATCHLIST],
  ])("refuses %s", async (_, kinds, enabled, intent) => {
    useActionProvider("trakt", kinds ? { kinds } : {});
    const account = await setup({ trakt: membership() }, { enabled });

    expect(await act(account, intent)).toEqual([
      { provider: "trakt", ok: false, error: "not_available" },
    ]);
    expect(performMocks.get("trakt")).not.toHaveBeenCalled();
  });
});
