import { useEffect, useState } from "react";
import { CONNECTION_SOURCES, isProviderId } from "@stremlist/shared/providers";
import type { ConnectionSource, ProviderId } from "@stremlist/shared/providers";
import type { ConnectionSummary } from "@stremlist/shared/stremio.types";
import { api } from "../lib/api";

/**
 * Source lists that a Connection unlocks, including the account's own lists.
 * Falls back to the static `CONNECTION_SOURCES` when the request fails.
 */
async function fetchConnectionSources(
  accountId: string,
  provider: ProviderId,
): Promise<ConnectionSource[]> {
  const fallback = CONNECTION_SOURCES[provider] ?? [];
  try {
    const res = await api[":accountId"].connections[":provider"].sources.$get({
      param: { accountId, provider },
    });
    const body = await res.json();
    return res.ok && "sources" in body ? body.sources : fallback;
  } catch {
    return fallback;
  }
}

/**
 * What each Connection of the Account unlocks. It depends on the account
 * (its own lists), so the page asks the backend once the Connections are
 * known.
 */
export function useConnectionSources(
  accountId: string | null,
  connections: ConnectionSummary[],
) {
  const [connectionSources, setConnectionSources] = useState<
    Partial<Record<ProviderId, ConnectionSource[]>>
  >({});
  // A string, so that the same Connections in a new array ask nothing again.
  const connectedKey = connections.map((c) => c.provider).join(",");

  const active = !!accountId && !!connectedKey;

  useEffect(() => {
    if (!accountId || !connectedKey) return;
    let cancelled = false;
    const providers = connectedKey.split(",").filter(isProviderId);
    void Promise.all(
      providers.map(
        async (provider) =>
          [
            provider,
            await fetchConnectionSources(accountId, provider),
          ] as const,
      ),
    ).then((entries) => {
      if (!cancelled) setConnectionSources(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, connectedKey]);

  return active ? connectionSources : {};
}
