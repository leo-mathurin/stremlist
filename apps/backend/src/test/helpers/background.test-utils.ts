import { afterEach, beforeEach } from "vite-plus/test";
import { db } from "./mock-supabase";

const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

/**
 * Runs the calling test file like a Vercel Function: the real
 * `scheduleBackgroundTask` hands each task to the request context's
 * `waitUntil`, as the Vercel runtime provides it. The test can then wait for
 * the work that its requests scheduled. After each test, it ends stalled
 * database queries and waits for the tasks that are still running, before
 * the next test resets the stores, and
 * puts back the request context and `VERCEL` value that were there before.
 */
export function useBackgroundTasks() {
  const pending: Promise<unknown>[] = [];
  const tasks = { scheduled: 0 };
  let previousContext: PropertyDescriptor | undefined;
  let previousVercel: string | undefined;

  async function settle() {
    let settled = 0;
    while (settled < pending.length) {
      const batch = pending.slice(settled);
      settled = pending.length;
      await Promise.all(batch);
    }
  }

  beforeEach(() => {
    pending.length = 0;
    tasks.scheduled = 0;
    previousContext = Object.getOwnPropertyDescriptor(
      globalThis,
      REQUEST_CONTEXT,
    );
    previousVercel = process.env.VERCEL;
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

  afterEach(async () => {
    db.releaseStalls();
    try {
      await settle();
    } finally {
      if (previousContext === undefined) {
        Reflect.deleteProperty(globalThis, REQUEST_CONTEXT);
      } else {
        Object.defineProperty(globalThis, REQUEST_CONTEXT, previousContext);
      }
      if (previousVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = previousVercel;
    }
  });

  return {
    get scheduled() {
      return tasks.scheduled;
    },
    settle,
  };
}
