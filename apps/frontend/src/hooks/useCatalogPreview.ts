import { createContext, use, useEffect, useRef, useState } from "react";
import type { InferRequestType } from "hono/client";
import type { CatalogPreview } from "@stremlist/shared/catalog-preview";
import { listSourcesKey } from "@stremlist/shared/list-merge";
import type { SourceId } from "@stremlist/shared/providers";
import type { SourceProblemReason } from "@stremlist/shared/source-problems";
import type {
  ConnectionSummary,
  NewTitlesSettings,
} from "@stremlist/shared/stremio.types";
import { api } from "@/lib/api";
import { previewConnectionKey } from "@/lib/connections";
import { newTitlesSort } from "@/lib/new-titles";
import type { ListFormRow } from "@/lib/list-form";
import { queueWait, retryDelay } from "@/lib/provider-queue";
import type { QueueWait } from "@/lib/provider-queue";

/**
 * The Account's Connections, for the parts of the configure page that read
 * through them, such as the Catalog preview. None outside the page.
 */
export const ConnectionsContext = createContext<ConnectionSummary[]>([]);

type PreviewBody = InferRequestType<typeof api.lists.preview.$post>["json"];

/**
 * What a preview shows: one List of the rows, or the built-in "New titles"
 * catalog, which reads the Titles detected in the other Lists.
 */
export type PreviewSubject =
  | { kind: "list"; list: ListFormRow }
  | { kind: "new-titles"; settings: NewTitlesSettings; sources: SourceId[] };

type CatalogPreviewState =
  | { status: "loading" }
  | { status: "queued"; wait: QueueWait }
  | { status: "ready"; preview: CatalogPreview; updating: boolean }
  | {
      status: "problem";
      reason: SourceProblemReason;
      source?: SourceId;
    }
  | { status: "error" };

const SETTINGS_DEBOUNCE_MS = 300;

export function previewBody(
  subject: PreviewSubject,
  accountKey: string | null,
) {
  if (subject.kind === "new-titles") {
    const { sortOption, displayMode, catalogSettings } = subject.settings;
    return {
      kind: "new-titles",
      accountKey: accountKey ?? undefined,
      sortOption: newTitlesSort(sortOption),
      displayMode,
      catalogSettings,
      sources: subject.sources,
    } satisfies PreviewBody;
  }
  const { list } = subject;
  return {
    accountKey: accountKey ?? undefined,
    provider: list.provider,
    sourceRef: list.sourceRef,
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
  } satisfies PreviewBody;
}

function subjectSource(subject: PreviewSubject) {
  return subject.kind === "list" ? listSourcesKey(subject.list) : "new-titles";
}

/**
 * The preview of a List, or of "New titles", while `enabled`. A change of sort or filters keeps
 * the current preview on screen (marked `updating`) until the new one comes;
 * a change of Source lists starts again from the loading state. A change of
 * the Account's Connection to a Provider of the List (see
 * `previewConnectionKey`) reads the preview again.
 */
export function useCatalogPreview({
  subject,
  accountKey,
  enabled,
}: {
  subject: PreviewSubject;
  accountKey: string | null;
  enabled: boolean;
}) {
  const [state, setState] = useState<CatalogPreviewState>({
    status: "loading",
  });
  const [attempt, setAttempt] = useState(0);
  const source = subjectSource(subject);
  const shownSource = useRef<string | null>(null);
  const connections = use(ConnectionsContext);
  const connectionKey =
    subject.kind === "list"
      ? previewConnectionKey(subject.list, connections)
      : "";
  const nextBody = previewBody(subject, accountKey);
  const bodyKey = JSON.stringify(nextBody);
  const [shown, setShown] = useState({ key: bodyKey, body: nextBody });
  if (shown.key !== bodyKey) setShown({ key: bodyKey, body: nextBody });
  const body = shown.body;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const sameSource = shownSource.current === source;
    setState((current) =>
      sameSource && current.status === "ready"
        ? { ...current, updating: true }
        : { status: "loading" },
    );
    let wait: QueueWait | null = null;
    const ask = (ticket?: string) => {
      api.lists.preview
        .$post({ json: { ...body, ticket } })
        .then(async (res) => {
          if (!res.ok) throw new Error("preview failed");
          const preview = await res.json();
          if (cancelled) return;
          if (!preview.ok && preview.reason === "queued") {
            wait = queueWait(preview, Date.now(), wait);
            setState({ status: "queued", wait });
            timer = setTimeout(
              () => ask(preview.ticket ?? undefined),
              retryDelay(preview.retryMs),
            );
            return;
          }
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
    };
    let timer = setTimeout(() => ask(), sameSource ? SETTINGS_DEBOUNCE_MS : 0);
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
