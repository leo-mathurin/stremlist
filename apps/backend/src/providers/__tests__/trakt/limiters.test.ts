import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { traktGetJson, traktPost } from "../../trakt/api";
import type { ConnectionAccess } from "../../types";
import {
  calls,
  connection,
  json,
  resetTraktTest,
  restoreTraktTest,
  route,
} from "./harness";

// No mock of ../../http here: these tests use the real limiters.

beforeEach(() => {
  resetTraktTest();
  vi.useFakeTimers();
  route("GET /users/me/watchlist", json([]));
  route("POST /sync/watchlist", json({}));
});

afterEach(() => {
  vi.useRealTimers();
  restoreTraktTest();
});

function user(
  username: string,
  accountId = `sl_${username}`,
): ConnectionAccess {
  return { ...connection(), username, accountId };
}

/** Whether the promise settles without advancing the rate-limit clock. */
async function settlesNow(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await vi.advanceTimersByTimeAsync(0);
  return settled;
}

describe("Trakt limiters per user", () => {
  it("does not delay a user's read behind another user's backlog", async () => {
    const a = user("limiter-a");
    const b = user("limiter-b");

    // More reads than one user may make in 5 minutes: the last ones wait.
    const backlog = Array.from({ length: 460 }, () =>
      traktGetJson("/users/me/watchlist", a),
    );
    const blocked = Promise.all(backlog);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(450);

    expect(await settlesNow(traktGetJson("/users/me/watchlist", b))).toBe(true);
    expect(calls).toHaveLength(451);

    // The backlog goes on once the user's window moves.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await blocked;
    expect(calls).toHaveLength(461);
  });

  it("gives users without a username a limiter each", async () => {
    const a = { ...user("x", "sl_nameless-a"), username: null };
    const b = { ...user("x", "sl_nameless-b"), username: null };

    const backlog = Promise.all(
      Array.from({ length: 460 }, () => traktGetJson("/users/me/watchlist", a)),
    );
    expect(await settlesNow(traktGetJson("/users/me/watchlist", b))).toBe(true);

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await backlog;
  });

  it("limits writes to one per second for each user, not for all", async () => {
    const a = user("writer-a");
    const b = user("writer-b");

    await traktPost("/sync/watchlist", a, {});
    const second = traktPost("/sync/watchlist", a, {});
    expect(await settlesNow(second)).toBe(false);
    expect(await settlesNow(traktPost("/sync/watchlist", b, {}))).toBe(true);

    await vi.advanceTimersByTimeAsync(1001);
    await second;
  });
});
