import { waitUntil } from "@vercel/functions";
import { meterBegin, meterEnd } from "./spike-meter";

type BackgroundTask = () => Promise<unknown>;

export function scheduleBackgroundTask(task: BackgroundTask): void {
  meterBegin();
  const promise = Promise.resolve()
    .then(task)
    .catch((error: unknown) => {
      console.error("Background task failed:", error);
    })
    .finally(meterEnd);

  if (process.env.VERCEL) {
    waitUntil(promise);
  }
}
