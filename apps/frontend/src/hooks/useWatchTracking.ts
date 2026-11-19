import type {
  WatchProviderId,
  WatchTrackingStatus,
} from "@stremlist/shared/watch-tracking";
import type { InferResponseType } from "hono/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";

/** What the last change left the installed Stremlist with, if it matters. */
export type WatchChangeNotice = "missing" | "unavailable" | null;

/** The account being changed, while its request runs. */
export interface WatchChange {
  provider: WatchProviderId;
  /** It turns automatic marks on: the library is read first. */
  starting: boolean;
}

const TOAST = { id: "watch-tracking" } as const;

const watchTrackingApi = api[":accountId"]["watch-tracking"];

type ChangeAnswer = InferResponseType<typeof watchTrackingApi.$put>;

type RefusalReason = Extract<ChangeAnswer, { reason: string }>["reason"];

function refusal(reason: RefusalReason | undefined) {
  switch (reason) {
    case "stremio-not-linked":
    case "signed-out":
      return "Link your Stremio account again to mark titles as watched automatically.";
    case "not-connected":
      return "Connect this account again to mark titles as watched on it.";
    case "unavailable":
      return "Stremlist could not read your Stremio library. Try again in a moment.";
    case undefined:
      return "Stremlist could not save this change. Try again.";
  }
  return "Stremlist could not save this change. Try again.";
}

async function readStatus(accountId: string) {
  try {
    const res = await watchTrackingApi.$get({ param: { accountId } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function sendChange(accountId: string, destinations: WatchProviderId[]) {
  try {
    const res = await watchTrackingApi.$put({
      param: { accountId },
      json: { destinations },
    });
    if (res.ok) return { saved: await res.json() };
    if (res.status !== 409 && res.status !== 400 && res.status !== 502) {
      return { saved: null, reason: undefined };
    }
    const body = await res.json();
    return { saved: null, reason: "reason" in body ? body.reason : undefined };
  } catch {
    return { saved: null, reason: undefined };
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
  onSignedOut: () => void,
) {
  const [status, setStatus] = useState<WatchTrackingStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<WatchChange | null>(null);
  const [notice, setNotice] = useState<WatchChangeNotice>(null);
  const run = useRef(0);
  const changing = useRef(false);
  const reloadAfterChange = useRef(false);

  const load = useCallback(() => {
    if (!accountId) return Promise.resolve();
    if (changing.current) {
      reloadAfterChange.current = true;
      return Promise.resolve();
    }
    const current = ++run.current;
    return readStatus(accountId).then((body) => {
      if (current !== run.current) return;
      if (body) setStatus(body);
      setFailed(!body);
    });
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

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
      run.current++;
      changing.current = true;
      setBusy({
        provider,
        starting: enabled && !status.destinations.some((d) => d.enabled),
      });
      setNotice(null);
      setStatus({
        ...status,
        destinations: status.destinations.map((d) =>
          d.provider === provider ? { ...d, enabled } : d,
        ),
      });
      const answer = await sendChange(accountId, destinations);
      const body = answer.saved;
      if (body) {
        setStatus(body.status);
        if (body.stremio === "signed-out") onSignedOut();
        if (body.status.destinations.some((d) => d.enabled)) {
          setNotice(
            body.stremio === "missing" || body.stremio === "unavailable"
              ? body.stremio
              : null,
          );
        }
      } else {
        setStatus(previous);
        reloadAfterChange.current = true;
        toast.error(refusal(answer.reason), TOAST);
        if (
          answer.reason === "signed-out" ||
          answer.reason === "stremio-not-linked"
        ) {
          onSignedOut();
        }
      }
      changing.current = false;
      setBusy(null);
      if (reloadAfterChange.current) {
        reloadAfterChange.current = false;
        void load();
      }
    },
    [accountId, busy, load, onSignedOut, status],
  );

  const clearNotice = useCallback(() => setNotice(null), []);

  return { status, failed, busy, notice, toggle, retry: load, clearNotice };
}
