import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useBackgroundTasks } from "../../test/helpers/background.test-utils";
import { scheduleBackgroundTask } from "../background";

const background = useBackgroundTasks();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function outsideVercel() {
  vi.stubEnv("VERCEL", "");
}

describe("scheduleBackgroundTask", () => {
  it("registers the task with Vercel so it can finish after the response", async () => {
    let runs = 0;

    scheduleBackgroundTask(() => {
      runs++;
      return Promise.resolve();
    });

    expect(background.scheduled).toBe(1);
    await background.settle();
    expect(runs).toBe(1);
  });

  it("runs the task locally without registering it with Vercel", async () => {
    outsideVercel();
    const ran = Promise.withResolvers<void>();

    scheduleBackgroundTask(() => {
      ran.resolve();
      return Promise.resolve();
    });
    await ran.promise;

    expect(background.scheduled).toBe(0);
  });

  it("does not delay the HTTP response while the task is pending", async () => {
    outsideVercel();
    const pendingTask = Promise.withResolvers<void>();
    let runs = 0;
    const app = new Hono().get("/probe", (c) => {
      scheduleBackgroundTask(() => {
        runs++;
        return pendingTask.promise;
      });
      return c.json({ ok: true });
    });

    const response = await app.request("/probe");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(runs).toBe(1);
    expect(background.scheduled).toBe(0);

    pendingTask.resolve();
    await pendingTask.promise;
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
      const error = vi.spyOn(console, "error");

      scheduleBackgroundTask(task);

      expect(background.scheduled).toBe(1);
      await expect(background.settle()).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        "Background task failed:",
        expect.any(Error),
      );
    },
  );
});
