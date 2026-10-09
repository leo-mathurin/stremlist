import { useEffect, useRef, useState } from "react";
import type { InferRequestType } from "hono/client";
import type { CatalogPreview } from "@stremlist/shared/catalog-preview";
import { listSourcesKey } from "@stremlist/shared/list-merge";
import type { SourceId } from "@stremlist/shared/providers";
import type { SourceProblemReason } from "@stremlist/shared/source-problems";
import { api } from "@/lib/api";
import type { ListFormRow } from "@/lib/list-form";

type PreviewBody = InferRequestType<typeof api.lists.preview.$post>["json"];

type CatalogPreviewState =
  | { status: "loading" }
  | { status: "ready"; preview: CatalogPreview; updating: boolean }
  | {
      status: "problem";
      reason: SourceProblemReason;
      /** In a merged List, the Source list that has the problem. */
      source?: SourceId;
    }
  | { status: "error" };

/** Wait this long after the last settings change before asking again. */
const SETTINGS_DEBOUNCE_MS = 300;

/**
 * The preview of a List while `enabled`. A change of sort or filters keeps
 * the current preview on screen (marked `updating`) until the new one comes;
 * a change of Source lists starts again from the loading state.
 * `connectionKey` changes when the Account's Connection to a Provider of the
 * List changes (connected, disconnected, connected again, marked for renewal or
 * working again), so the preview is read again. It is not sent.
 */
export function useCatalogPreview({
  list,
  accountKey,
  connectionKey,
  enabled,
}: {
  list: ListFormRow;
  accountKey: string | null;
  connectionKey: string;
  enabled: boolean;
}) {
  const [state, setState] = useState<CatalogPreviewState>({
    status: "loading",
  });
  const [attempt, setAttempt] = useState(0);
  const source = listSourcesKey(list);
  const shownSource = useRef<string | null>(null);
  // A string, so that a new object with the same values asks nothing again.
  const body = JSON.stringify({
    accountKey: accountKey ?? undefined,
    provider: list.provider,
    sourceRef: list.sourceRef,
    // Labels name Source lists on this page only: a new label is no new
    // preview. A List with one Source list sends none.
    mergedSources:
      list.mergedSources.length > 0
        ? list.mergedSources.map(({ provider, sourceRef }) => ({
            provider,
            sourceRef,
          }))
        : undefined,
    sortOption: list.sortOption,
    displayMode: list.displayMode,
    catalogSettings: list.catalogSettings,
  } satisfies PreviewBody);

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
          .$post({ json: JSON.parse(body) as PreviewBody })
          .then(async (res) => {
            if (!res.ok) throw new Error("preview failed");
            const preview = await res.json();
            if (cancelled) return;
            shownSource.current = source;
            setState(
              preview.ok
                ? { status: "ready", preview, updating: false }
                : {
                    status: "problem",
                    reason: preview.reason,
                    source: preview.source,
                  },
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
  }, [enabled, body, source, connectionKey, attempt]);

  const retry = () => {
    shownSource.current = null;
    setAttempt((current) => current + 1);
  };

  return { state, retry };
}
