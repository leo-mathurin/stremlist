import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CatalogPreviewRow,
  PreviewTitle,
} from "@stremlist/shared/catalog-preview";
import { api } from "@/lib/api";
import { retryDelay } from "@/lib/provider-queue";
import { previewBody } from "./useCatalogPreview";
import type { PreviewSubject } from "./useCatalogPreview";

type LoadStatus = "idle" | "loading" | "error";

/**
 * All the Titles of one Catalog of a preview, one page at a time: it starts
 * with the Titles that the preview already shows, and `loadMore` asks for
 * the next page. It asks with the List (or "New titles") as it was when it started, so that
 * the pages stay in one order.
 */
export function useCatalogTitles({
  subject,
  accountKey,
  row,
}: {
  subject: PreviewSubject;
  accountKey: string | null;
  row: CatalogPreviewRow;
}) {
  const [titles, setTitles] = useState<PreviewTitle[]>(row.titles);
  const [total, setTotal] = useState(row.total);
  const [next, setNext] = useState(row.titles.length);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [body] = useState(() => previewBody(subject, accountKey));
  const loading = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const hasMore = next < total;

  const loadMore = useCallback(() => {
    if (loading.current || !hasMore) return;
    loading.current = true;
    setStatus("loading");
    const offset = next;
    const catalog = { type: row.type, preset: row.preset };
    const ask = (ticket?: string) => {
      api.lists.preview.titles
        .$post({ json: { ...body, ticket, catalog, offset } })
        .then(async (res) => {
          if (!res.ok) throw new Error("preview page failed");
          const page = await res.json();
          if (!mounted.current) return;
          if (!page.ok && page.reason === "queued") {
            timer.current = setTimeout(
              () => ask(page.ticket ?? undefined),
              retryDelay(page.retryMs),
            );
            return;
          }
          if (!page.ok) throw new Error(page.reason);
          loading.current = false;
          setTitles((current) => {
            const known = new Set(current.map((title) => title.id));
            return [
              ...current,
              ...page.titles.filter((title) => !known.has(title.id)),
            ];
          });
          setNext(offset + page.titles.length);
          setTotal(page.titles.length === 0 ? offset : page.total);
          setStatus("idle");
        })
        .catch(() => {
          if (!mounted.current) return;
          loading.current = false;
          setStatus("error");
        });
    };
    ask();
  }, [body, hasMore, next, row.type, row.preset]);

  return { titles, total, status, hasMore, loadMore };
}
