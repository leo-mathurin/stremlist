import type { WatchProviderId } from "@stremlist/shared/watch-tracking";
import type { WatchTrackingStatus } from "@stremlist/shared/watch-tracking";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";

/** What the last change of a Destination left to say, if anything. */
export type WatchChangeNotice =
  /** The installed Stremlist is not in the linked Stremio account. */
  | "missing"
  /** Stremio did not take the new manifest: the sweep still works. */
  | "stremio-unavailable"
  | null;

/**
 * Watch tracking of an Account (ADR 0003). A change applies at once, without
 * the Save button: turning a Destination on reads the Watched baseline and
 * updates the installed Stremlist. `refreshKey` changes when a Connection or
 * the Stremio link changes, so the list follows them.
 */
export function useWatchTracking(accountId: string | null, refreshKey: string) {
  const [status, setStatus] = useState<WatchTrackingStatus | null>(null);
  const [failed, setFailed] = useState(false);
  /** The Destination being changed, while its request runs. */
  const [busy, setBusy] = useState<WatchProviderId | null>(null);
  /** The change being made turns Watch tracking on: it reads the library. */
  const [starting, setStarting] = useState(false);
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
      setStarting(enabled && !status.destinations.some((d) => d.enabled));
      setBusy(provider);
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
          if (body.stremio === "missing") setNotice("missing");
          else if (
            body.stremio === "unavailable" ||
            body.stremio === "signed-out"
          ) {
            setNotice("stremio-unavailable");
          }
          return;
        }
        setStatus(previous);
        const reason =
          res.status === 409 || res.status === 400 || res.status === 502
            ? ((await res.json()) as { reason?: string }).reason
            : undefined;
        toast.error(
          reason === "stremio-not-linked" || reason === "signed-out"
            ? "Link your Stremio account again to use Watch tracking."
            : reason === "not-connected"
              ? "Connect this account again to use it for Watch tracking."
              : "Stremlist could not read your Stremio library. Try again in a moment.",
          { id: "watch-tracking" },
        );
      } catch {
        setStatus(previous);
        toast.error("Stremlist could not save this change. Try again.", {
          id: "watch-tracking",
        });
      } finally {
        changing.current = false;
        setBusy(null);
        if (reloadAfterChange.current) {
          reloadAfterChange.current = false;
          void load();
        }
      }
    },
    [accountId, busy, load, status],
  );

  return { status, failed, busy, starting, notice, toggle, retry: load };
}
