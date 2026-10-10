import { connectionProviders, listSources } from "@stremlist/shared/list-merge";
import type { MergeableList } from "@stremlist/shared/list-merge";
import type { ProviderId } from "@stremlist/shared/providers";
import type { ConnectionSummary } from "@stremlist/shared/stremio.types";
import type { ListSyncState } from "./list-sync";

/** Providers of a List whose Connection the Account does not have. */
export function missingConnections(
  list: MergeableList,
  connections: ConnectionSummary[],
): ProviderId[] {
  return connectionProviders(list).filter(
    (provider) =>
      !connections.some((connection) => connection.provider === provider),
  );
}

/**
 * The Provider that a List row asks to connect: the one of the Connection
 * problem in its sync status (in a merged List, of the Source list with the
 * problem), else the first missing Connection, else the List's Provider.
 */
export function connectProviderOf(
  list: MergeableList,
  sync: ListSyncState | null,
  missing: ProviderId[],
): ProviderId {
  return (
    (sync?.kind === "connection" ? sync.source?.provider : undefined) ??
    missing.at(0) ??
    list.provider
  );
}

/**
 * Identifies the Account's Connections to the Providers of a List's Source
 * lists, or "". It changes when one of them is connected, disconnected,
 * connected again, marked for renewal or working again: then a Catalog
 * preview can read something else.
 */
export function previewConnectionKey(
  list: MergeableList,
  connections: ConnectionSummary[],
): string {
  return [...new Set(listSources(list).map((source) => source.provider))]
    .map((provider) => {
      const connection = connections.find(
        (entry) => entry.provider === provider,
      );
      return connection
        ? `${provider}:${connection.connectedAt}:${connection.username ?? ""}:${connection.needsRenewalSince ?? ""}`
        : "";
    })
    .filter(Boolean)
    .join(",");
}
