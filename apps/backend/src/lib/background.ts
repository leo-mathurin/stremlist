import { waitUntil } from "@vercel/functions";

type BackgroundTask = () => Promise<unknown>;

export function scheduleBackgroundTask(task: BackgroundTask): void {
  const promise = Promise.resolve()
    .then(task)
    .catch((error: unknown) => {
      console.error("Background task failed:", error);
    });

  if (process.env.VERCEL) {
    waitUntil(promise);
  }
}
