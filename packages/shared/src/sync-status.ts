import type { ProviderId } from "./providers";
import type { SourceProblemReason } from "./source-problems";

/**
 * The outcome of the latest refreshes of a List: the reads of its Source list
 * on the Provider, by a Stremio request, a save or a manual refresh.
 */
export interface ListSyncStatus {
  /** The Provider of the Source list that was read. */
  provider: ProviderId;
  /** The Source list that was read (a List can change its Source list). */
  sourceRef: string;
  /** When Stremlist last tried to read the Source list. */
  lastAttemptAt: string;
  /** When a read last succeeded, or null if none did. */
  lastSuccessAt: string | null;
  /** Titles in the Catalog after the last successful refresh. */
  titleCount: number | null;
  /** Why the last refresh failed, or null when it succeeded. */
  problem: SourceProblemReason | null;
  /** When the current run of failed refreshes started. */
  failingSince: string | null;
}

/**
 * The sync status of each Source list of each List, by List ID, in the
 * order of `listSources`; null for a Source list that was never read.
 */
export type ListSyncStatuses = Record<string, (ListSyncStatus | null)[]>;
