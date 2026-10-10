import { use, useEffect, useMemo, useRef, useState } from "react";
import type { InferRequestType } from "hono/client";
import type { CatalogPreview } from "@stremlist/shared/catalog-preview";
import { listSourcesKey } from "@stremlist/shared/list-merge";
import type { SourceId } from "@stremlist/shared/providers";
import type { SourceProblemReason } from "@stremlist/shared/source-problems";
import { ConnectionsContext } from "@/hooks/connections-context";
import { api } from "@/lib/api";
import { previewConnectionKey } from "@/lib/connections";
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

function previewBody(
  list: ListFormRow,
  accountKey: string | null,
): PreviewBody {
  return {
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
  };
}

/**
 * The preview of a List while `enabled`. A change of sort or filters keeps
 * the current preview on screen (marked `updating`) until the new one comes;
 * a change of Source lists starts again from the loading state. A change of
 * the Account's Connection to a Provider of the List (see
 * `previewConnectionKey`) reads the preview again.
 */
export function useCatalogPreview({
  list,
  accountKey,
  enabled,
}: {
  list: ListFormRow;
  accountKey: string | null;
  enabled: boolean;
}) {
  const [state, setState] = useState<CatalogPreviewState>({
    status: "loading",
  });
  const [attempt, setAttempt] = useState(0);
  const source = listSourcesKey(list);
  const shownSource = useRef<string | null>(null);
  const connectionKey = previewConnectionKey(list, use(ConnectionsContext));
  const nextBody = previewBody(list, accountKey);
  const bodyKey = JSON.stringify(nextBody);
  // Keyed by value, so that a new object with the same values asks nothing
  // again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const body = useMemo(() => nextBody, [bodyKey]);

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
          .$post({ json: body })
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
