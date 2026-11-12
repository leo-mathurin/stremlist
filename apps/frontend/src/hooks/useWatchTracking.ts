import type {
  WatchProviderId,
  WatchTrackingStatus,
} from "@stremlist/shared/watch-tracking";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";

/** What the last change left the installed Stremlist with, if it matters. */
export type WatchChangeNotice =
  /** The linked Stremio account has no Stremlist installed. */
  | "missing"
  /** Stremio did not answer the update. */
  | "unavailable"
  | null;

/** The account being changed, while its request runs. */
export interface WatchChange {
  provider: WatchProviderId;
  /** It turns automatic marks on: the library is read first. */
  starting: boolean;
}

const TOAST = { id: "watch-tracking" } as const;

/** What a refused change tells the member. */
function refusal(reason: string | undefined): string {
  switch (reason) {
    case "stremio-not-linked":
    case "signed-out":
      return "Link your Stremio account again to mark titles as watched automatically.";
    case "not-connected":
      return "Connect this account again to mark titles as watched on it.";
    case "unavailable":
      return "Stremlist could not read your Stremio library. Try again in a moment.";
    default:
      return "Stremlist could not save this change. Try again.";
  }
}

/**
 * Automatic watched marks of an Account (ADR 0003). A change applies at
 * once, without the Save button: turning the first account on reads the
 * Watched baseline and updates the installed Stremlist. `refreshKey`
 * changes when a Connection or the Stremio link changes, so the list
 * follows them; coming back to the tab reads it again too.
 */
export function useWatchTracking(
  accountId: string | null,
  refreshKey: string,
  /** Stremio refused the stored key: let the Stremio card find it out. */
  onSignedOut: () => void,
) {
  const [status, setStatus] = useState<WatchTrackingStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<WatchChange | null>(null);
  const [notice, setNotice] = useState<WatchChangeNotice>(null);
  const run = useRef(0);
  const changing = useRef(false);
  /** A refresh asked for during a change, done once the change settles. */
  const reloadAfterChange = useRef(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    if (changing.current) {
      reloadAfterChange.current = true;
      return;
    }
    const current = ++run.current;
    try {
      const res = await api[":accountId"]["watch-tracking"].$get({
        param: { accountId },
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      if (current !== run.current) return;
      setStatus(body);
      setFailed(false);
    } catch {
      if (current === run.current) setFailed(true);
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // A tab left open shows fresh counts and last titles when it comes back.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const toggle = useCallback(
    async (provider: WatchProviderId, enabled: boolean) => {
      if (!accountId || !status || busy) return;
      const destinations = status.destinations
        .filter((d) => (d.provider === provider ? enabled : d.enabled))
        .map((d) => d.provider);
      const previous = status;
      // A refresh in flight is older than this change: its answer is dropped.
      run.current++;
      changing.current = true;
      setBusy({
        provider,
        starting: enabled && !status.destinations.some((d) => d.enabled),
      });
      setNotice(null);
      // The checkbox follows the click at once; a failure puts it back.
      setStatus({
        ...status,
        destinations: status.destinations.map((d) =>
          d.provider === provider ? { ...d, enabled } : d,
        ),
      });
      try {
        const res = await api[":accountId"]["watch-tracking"].$put({
          param: { accountId },
          json: { destinations },
        });
        if (res.ok) {
          const body = await res.json();
          setStatus(body.status);
          if (body.status.destinations.some((d) => d.enabled)) {
            // A sign-out also forgets the link: the card asks for a new one.
            setNotice(
              body.stremio === "missing" || body.stremio === "unavailable"
                ? body.stremio
                : null,
            );
          }
          return;
        }
        setStatus(previous);
        // A refused change may still have saved part of it: read it back.
        reloadAfterChange.current = true;
        const reason =
          res.status === 409 || res.status === 400 || res.status === 502
            ? ((await res.json()) as { reason?: string }).reason
            : undefined;
        toast.error(refusal(reason), TOAST);
        if (reason === "signed-out") onSignedOut();
      } catch {
        setStatus(previous);
        reloadAfterChange.current = true;
        toast.error(refusal(undefined), TOAST);
      } finally {
        changing.current = false;
        setBusy(null);
        if (reloadAfterChange.current) {
          reloadAfterChange.current = false;
          void load();
        }
      }
    },
    [accountId, busy, load, onSignedOut, status],
  );

  const clearNotice = useCallback(() => setNotice(null), []);

  return { status, failed, busy, notice, toggle, retry: load, clearNotice };
}
