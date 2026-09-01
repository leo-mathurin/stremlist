import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vercelMocks = vi.hoisted(() => ({
  waitUntil: vi.fn(),
}));

vi.mock("@vercel/functions", () => vercelMocks);

import { scheduleBackgroundTask } from "../background";

describe("scheduleBackgroundTask", () => {
  const originalVercel = process.env.VERCEL;

  beforeEach(() => {
    vercelMocks.waitUntil.mockReset();
    delete process.env.VERCEL;
  });

  afterEach(() => {
    if (originalVercel === undefined) {
      delete process.env.VERCEL;
    } else {
      process.env.VERCEL = originalVercel;
    }
  });

  it("registers the task with Vercel so it can finish after the response", async () => {
    process.env.VERCEL = "1";
    const task = vi.fn().mockResolvedValue(undefined);

    scheduleBackgroundTask(task);

    expect(vercelMocks.waitUntil).toHaveBeenCalledOnce();
    const promise = vercelMocks.waitUntil.mock.calls[0][0] as Promise<unknown>;
    await promise;
    expect(task).toHaveBeenCalledOnce();
  });

  it("runs the task locally without registering it with Vercel", async () => {
    const task = vi.fn().mockResolvedValue(undefined);

    scheduleBackgroundTask(task);
    await vi.waitFor(() => {
      expect(task).toHaveBeenCalledOnce();
    });

    expect(vercelMocks.waitUntil).not.toHaveBeenCalled();
  });

  it("does not delay the HTTP response while the task is pending", async () => {
    let finishTask: (() => void) | undefined;
    const pendingTask = new Promise<void>((resolve) => {
      finishTask = resolve;
    });
    const task = vi.fn(() => pendingTask);
    const app = new Hono().get("/probe", (c) => {
      scheduleBackgroundTask(task);
      return c.json({ ok: true });
    });

    const response = await app.request("/probe");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(task).toHaveBeenCalledOnce();
    expect(vercelMocks.waitUntil).not.toHaveBeenCalled();

    finishTask?.();
    await pendingTask;
  });

  it.each([
    [
      "synchronous",
      () => {
        throw new Error("sync failure");
      },
    ],
    ["asynchronous", () => Promise.reject(new Error("async failure"))],
  ])(
    "logs a %s task failure without an unhandled rejection",
    async (_, task) => {
      const error = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      scheduleBackgroundTask(task);

      await vi.waitFor(() => {
        expect(error).toHaveBeenCalledWith(
          "Background task failed:",
          expect.any(Error),
        );
      });
    },
  );
});
