import { useCallback, useEffect, useRef, useState } from "react";
import type { CatalogPreview } from "@stremlist/shared/catalog-preview";
import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import type { DisplayMode } from "@stremlist/shared/constants";
import type { ProviderId } from "@stremlist/shared/providers";
import type { SourceProblemReason } from "@stremlist/shared/source-problems";
import { api } from "@/lib/api";

export interface CatalogPreviewInput {
  accountKey: string | null;
  provider: ProviderId;
  sourceRef: string;
  sortOption: string;
  displayMode: DisplayMode;
  catalogSettings: CatalogSettings;
  /**
   * Changes when the Account's Connection to the Provider changes (connected,
   * disconnected, connected again), so the preview is read again. Not sent.
   */
  connectionKey: string;
}

export type CatalogPreviewState =
  | { status: "loading" }
  | { status: "ready"; preview: CatalogPreview; updating: boolean }
  | { status: "problem"; reason: SourceProblemReason }
  | { status: "error" };

/** Wait this long after the last settings change before asking again. */
const SETTINGS_DEBOUNCE_MS = 300;

/**
 * The preview of a List while `enabled`. A change of sort or filters keeps
 * the current preview on screen (marked `updating`) until the new one comes;
 * a change of Source list starts again from the loading state.
 */
export function useCatalogPreview(
  input: CatalogPreviewInput,
  enabled: boolean,
) {
  const [state, setState] = useState<CatalogPreviewState>({
    status: "loading",
  });
  const [attempt, setAttempt] = useState(0);
  const source = `${input.provider}:${input.sourceRef}`;
  const shownSource = useRef<string | null>(null);
  const request = JSON.stringify({
    accountKey: input.accountKey ?? undefined,
    provider: input.provider,
    sourceRef: input.sourceRef,
    sortOption: input.sortOption,
    displayMode: input.displayMode,
    catalogSettings: input.catalogSettings,
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const sameSource = shownSource.current === source;
    setState((current) =>
      sameSource && current.status === "ready"
        ? { ...current, updating: true }
        : { status: "loading" },
    );
    const timer = setTimeout(
      () => {
        api.lists.preview
          .$post({
            json: JSON.parse(request) as Parameters<
              typeof api.lists.preview.$post
            >[0]["json"],
          })
          .then(async (res) => {
            if (!res.ok) throw new Error("preview failed");
            const body = await res.json();
            if (cancelled) return;
            shownSource.current = source;
            setState(
              body.ok
                ? { status: "ready", preview: body, updating: false }
                : { status: "problem", reason: body.reason },
            );
          })
          .catch(() => {
            if (!cancelled) setState({ status: "error" });
          });
      },
      sameSource ? SETTINGS_DEBOUNCE_MS : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, request, source, input.connectionKey, attempt]);

  const retry = useCallback(() => {
    shownSource.current = null;
    setAttempt((current) => current + 1);
  }, []);

  return { state, retry };
}
