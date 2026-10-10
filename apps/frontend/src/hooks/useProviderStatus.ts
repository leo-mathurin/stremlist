import { useEffect, useState } from "react";
import { PROVIDER_IDS, PROVIDERS } from "@stremlist/shared/providers";
import type { ProviderId } from "@stremlist/shared/providers";
import { api } from "../lib/api";

export type ProviderStatus = { enabled: boolean; connectable: boolean };

function defaultProviderStatus(): Record<ProviderId, ProviderStatus> {
  return Object.fromEntries(
    PROVIDER_IDS.map((id) => [
      id,
      { enabled: true, connectable: PROVIDERS[id].connection !== "none" },
    ]),
  ) as Record<ProviderId, ProviderStatus>;
}

/**
 * Whether each Provider is on and can be connected right now, as the backend
 * says. Until it answers (or when it cannot), every Provider is on and the
 * ones with Connections are connectable: the backend still refuses what it
 * cannot do.
 */
export function useProviderStatus(): Record<ProviderId, ProviderStatus> {
  const [providerStatus, setProviderStatus] = useState(defaultProviderStatus);

  useEffect(() => {
    api.providers
      .$get()
      .then((res) => res.json())
      .then((data) => {
        setProviderStatus((current) => {
          const next = { ...current };
          for (const provider of data.providers) {
            next[provider.id] = {
              enabled: provider.enabled,
              connectable: provider.connectable,
            };
          }
          return next;
        });
      })
      .catch(() => {
        // Keep the defaults.
      });
  }, []);

  return providerStatus;
}
