import type { ListSyncState } from "@stremlist/shared/sync-status";

/**
 * How much a List needs the user: "bad" when it does not show in Stremio,
 * "warn" when Stremio shows older Titles or a Connection is missing, null
 * when nothing is wrong.
 */
export function attentionTone(
  sync: ListSyncState | null,
): "warn" | "bad" | null {
  if (sync?.kind === "connection") return sync.renew ? "bad" : "warn";
  if (sync?.kind === "failing") return sync.showsOlderTitles ? "warn" : "bad";
  return null;
}
