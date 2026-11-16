import { useEffect, useState } from "react";
import { PROVIDERS } from "@stremlist/shared/providers";
import type { ProviderId } from "@stremlist/shared/providers";
import { api } from "../lib/api";

export type ProviderStatus = {
  enabled: boolean;
  connectable: boolean;
  /** When the monitor found the Provider down, or null. */
  outageSince: string | null;
};

/** How often the page asks again, so an outage shows and clears by itself. */
const REFRESH_MS = 2 * 60_000;

function defaultStatus(id: ProviderId): ProviderStatus {
  return {
    enabled: true,
    connectable: PROVIDERS[id].connection !== "none",
    outageSince: null,
  };
}

/** Lists every Provider by name: a new Provider fails the type check here. */
function defaultProviderStatus(): Record<ProviderId, ProviderStatus> {
  return {
    imdb: defaultStatus("imdb"),
    trakt: defaultStatus("trakt"),
    simkl: defaultStatus("simkl"),
    mdblist: defaultStatus("mdblist"),
    justwatch: defaultStatus("justwatch"),
    senscritique: defaultStatus("senscritique"),
    letterboxd: defaultStatus("letterboxd"),
  };
}

/**
 * Whether each Provider is on, can be connected, and has an outage right
 * now, as the backend says. The page asks again every 2 minutes while it is
 * visible, and when it becomes visible again. Until the backend answers,
 * every Provider is on, has no outage, and the ones with Connections are
 * connectable. When a later request fails, the last answer stays: a failed
 * request never shows or clears an outage by itself.
 */
export function useProviderStatus(): Record<ProviderId, ProviderStatus> {
  const [providerStatus, setProviderStatus] = useState(defaultProviderStatus);

  useEffect(() => {
    let active = true;
    const load = () => {
      api.providers
        .$get()
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((data) => {
          if (!active) return;
          setProviderStatus((current) => {
            const next = { ...current };
            for (const provider of data.providers) {
              next[provider.id] = {
                enabled: provider.enabled,
                connectable: provider.connectable,
                // A backend from before outages sends none: no outage.
                outageSince: provider.outageSince ?? null,
              };
            }
            return next;
          });
        })
        .catch(() => {
          // Keep the last answer.
        });
    };
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return providerStatus;
}
