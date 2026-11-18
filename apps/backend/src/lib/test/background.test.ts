import { Hono } from "hono";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import type { waitUntil } from "@vercel/functions";
import { scheduleBackgroundTask } from "../background";

const vercelMocks = vi.hoisted(() => ({
  waitUntil: vi.fn<typeof waitUntil>(),
}));

vi.mock("@vercel/functions", () => vercelMocks);

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
    let runs = 0;

    scheduleBackgroundTask(() => {
      runs++;
      return Promise.resolve();
    });

    expect(vercelMocks.waitUntil).toHaveBeenCalledOnce();
    const [promise] = vercelMocks.waitUntil.mock.calls[0];
    await promise;
    expect(runs).toBe(1);
  });

  it("runs the task locally without registering it with Vercel", async () => {
    const ran = Promise.withResolvers<void>();

    scheduleBackgroundTask(() => {
      ran.resolve();
      return Promise.resolve();
    });
    await ran.promise;

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
      process.env.VERCEL = "1";
      const error = vi.spyOn(console, "error");

      scheduleBackgroundTask(task);

      const [promise] = vercelMocks.waitUntil.mock.calls[0];
      await expect(promise).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        "Background task failed:",
        expect.any(Error),
      );
    },
  );
});
