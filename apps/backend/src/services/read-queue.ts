import type { ProviderId, SourceId } from "@stremlist/shared/providers";
import { isProviderId } from "@stremlist/shared/providers";
import { supabase } from "../lib/supabase";

/** Write the estimate of a waiting read at most this often. */
const WRITE_EVERY_MS = 5_000;
/** An estimate that its read did not write again for this long is over. */
const STALE_AFTER_MS = 30_000;

/**
 * The estimate of a List read that waits in a Provider queue, for the
 * configure page (`list_read_queue`). Best effort: a failed write is
 * logged, never thrown.
 */
export function listReadQueueMark(source: SourceId & { listId: string }) {
  let writtenAt = 0;
  let write: Promise<void> | null = null;
  const key = {
    list_id: source.listId,
    provider: source.provider,
    source_ref: source.sourceRef,
  };
  const logged = (action: string) => (error: { message: string } | null) => {
    if (error)
      console.error(
        `Failed to ${action} the queue estimate of list ${source.listId}:`,
        error.message,
      );
  };
  return {
    /** The read waits: it should end in about `waitMs`. */
    queued(waitMs: number) {
      const at = Date.now();
      if (at - writtenAt < WRITE_EVERY_MS) return;
      writtenAt = at;
      const previous = write;
      write = (async () => {
        await previous;
        const { error } = await supabase.from("list_read_queue").upsert(
          {
            ...key,
            ready_at: new Date(at + waitMs).toISOString(),
            updated_at: new Date(at).toISOString(),
          },
          { onConflict: "list_id,provider,source_ref" },
        );
        logged("record")(error);
      })();
    },
    /** The read ended: forget its estimate. */
    async done() {
      if (!write) return;
      await write;
      const { error } = await supabase
        .from("list_read_queue")
        .delete()
        .eq("list_id", key.list_id)
        .eq("provider", key.provider)
        .eq("source_ref", key.source_ref);
      logged("clear")(error);
    },
  };
}

/**
 * The waiting reads of each List, by List ID: the Provider and when the
 * read should end, from the latest current estimate of its Source lists.
 * Lists that wait for nothing are left out, also when the estimates cannot
 * be read.
 */
export async function getListReadQueue(
  listIds: string[],
): Promise<Record<string, { provider: ProviderId; readyAt: string }>> {
  if (listIds.length === 0) return {};
  const { data, error } = await supabase
    .from("list_read_queue")
    .select("list_id, provider, ready_at, updated_at")
    .in("list_id", listIds);
  if (error) {
    console.error("Failed to read list queue estimates:", error.message);
    return {};
  }
  const queue = new Map<string, { provider: ProviderId; readyAt: string }>();
  for (const row of data) {
    if (Date.now() - Date.parse(row.updated_at) > STALE_AFTER_MS) continue;
    if (!isProviderId(row.provider)) continue;
    const current = queue.get(row.list_id);
    if (!current || Date.parse(row.ready_at) > Date.parse(current.readyAt))
      queue.set(row.list_id, {
        provider: row.provider,
        readyAt: new Date(row.ready_at).toISOString(),
      });
  }
  return Object.fromEntries(queue);
}
