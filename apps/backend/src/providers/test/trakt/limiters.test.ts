import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { useMswServer } from "../../../test/helpers/msw.test-utils";
import { traktGetJson, traktPost } from "../../trakt/api";
import {
  calls,
  connection,
  json,
  resetTraktTest,
  restoreTraktTest,
  route,
} from "./harness";

const server = useMswServer();

beforeEach(() => {
  resetTraktTest(server);
  vi.useFakeTimers({ now: Date.now() });
  route("GET /users/me/watchlist", json([]));
  route("POST /sync/watchlist", json({}));
});

afterEach(() => {
  vi.useRealTimers();
  restoreTraktTest();
});

function user(username: string, accountId = `sl_${username}`) {
  return { ...connection(), username, accountId };
}

async function driveTimers(operation: Promise<unknown>) {
  let settled = false;
  void operation.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled) await vi.advanceTimersToNextTimerAsync();
  return operation;
}

function tracked(promise: Promise<unknown>) {
  const state = { settled: false };
  void promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

describe("Trakt limiters per user", () => {
  it("does not delay a user's read behind another user's backlog", async () => {
    const a = user("limiter-a");
    const b = user("limiter-b");
    const start = Date.now();

    const backlog = Array.from({ length: 460 }, () =>
      traktGetJson("/users/me/watchlist", a),
    );
    await Promise.all(backlog.slice(0, 450));
    const waiting = tracked(Promise.all(backlog.slice(450)));
    expect(calls).toHaveLength(450);

    await traktGetJson("/users/me/watchlist", b);
    expect(calls).toHaveLength(451);
    expect(waiting.settled).toBe(false);

    await driveTimers(Promise.all(backlog));
    expect(Date.now()).toBeGreaterThanOrEqual(start + 5 * 60_000);
    expect(calls).toHaveLength(461);
  });

  it("gives users without a username a limiter each", async () => {
    const a = { ...user("x", "sl_nameless-a"), username: null };
    const b = { ...user("x", "sl_nameless-b"), username: null };

    const backlog = Array.from({ length: 460 }, () =>
      traktGetJson("/users/me/watchlist", a),
    );
    await Promise.all([
      traktGetJson("/users/me/watchlist", b),
      ...backlog.slice(0, 450),
    ]);
    expect(calls).toHaveLength(451);

    await driveTimers(Promise.all(backlog));
    expect(calls).toHaveLength(461);
  });

  it("limits writes to one per second for each user, not for all", async () => {
    const a = user("writer-a");
    const b = user("writer-b");
    const start = Date.now();

    await traktPost("/sync/watchlist", a, {});
    const second = traktPost("/sync/watchlist", a, {});
    const waiting = tracked(second);
    await traktPost("/sync/watchlist", b, {});
    expect(waiting.settled).toBe(false);

    await driveTimers(second);
    expect(Date.now()).toBeGreaterThanOrEqual(start + 1000);
  });
});
