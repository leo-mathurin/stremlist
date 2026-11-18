import { afterEach, beforeEach } from "vite-plus/test";

const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

/**
 * Runs the calling test file like a Vercel Function: the real
 * `scheduleBackgroundTask` hands each task to the request context's
 * `waitUntil`, as the Vercel runtime provides it. The test can then wait for
 * the work that its requests scheduled.
 */
export function useBackgroundTasks() {
  const pending: Promise<unknown>[] = [];
  const tasks = { scheduled: 0 };

  beforeEach(() => {
    pending.length = 0;
    tasks.scheduled = 0;
    process.env.VERCEL = "1";
    Reflect.set(globalThis, REQUEST_CONTEXT, {
      get: () => ({
        waitUntil: (task: Promise<unknown>) => {
          tasks.scheduled += 1;
          pending.push(task);
        },
      }),
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, REQUEST_CONTEXT);
    delete process.env.VERCEL;
  });

  return {
    get scheduled() {
      return tasks.scheduled;
    },
    async settle() {
      let settled = 0;
      while (settled < pending.length) {
        const batch = pending.slice(settled);
        settled = pending.length;
        await Promise.all(batch);
      }
    },
  };
}
