import type {
  WatchProviderId,
  WatchTrackingStatus,
} from "@stremlist/shared/watch-tracking";
import type { InferResponseType } from "hono/client";
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

const watchTrackingApi = api[":accountId"]["watch-tracking"];

type ChangeAnswer = InferResponseType<typeof watchTrackingApi.$put>;

/** Why the backend refused a change, when it says. */
type RefusalReason = Extract<ChangeAnswer, { reason: string }>["reason"];

/** What a refused change tells the member. */
function refusal(reason: RefusalReason | undefined): string {
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
  // A reason from a newer backend than this page.
  return "Stremlist could not save this change. Try again.";
}

/** The Watch tracking status of an Account, or null when it cannot be read. */
async function readStatus(accountId: string) {
  try {
    const res = await watchTrackingApi.$get({ param: { accountId } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * Sends a change. A refusal comes with its reason when the backend gives
 * one; `reason` is undefined when Stremlist did not answer.
 */
async function sendChange(
  accountId: string,
  destinations: WatchProviderId[],
): Promise<
  | { saved: Extract<ChangeAnswer, { status: unknown }> }
  | { saved: null; reason: RefusalReason | undefined }
> {
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
  /** Stremio refused or forgot the key: let the Stremio card find it out. */
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

  const load = useCallback((): Promise<void> => {
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
      const answer = await sendChange(accountId, destinations);
      const body = answer.saved;
      if (body) {
        setStatus(body.status);
        // The update found the sign-out: the Stremio card shows it too.
        if (body.stremio === "signed-out") onSignedOut();
        if (body.status.destinations.some((d) => d.enabled)) {
          // A sign-out also forgets the link: the card asks for a new one.
          setNotice(
            body.stremio === "missing" || body.stremio === "unavailable"
              ? body.stremio
              : null,
          );
        }
      } else {
        setStatus(previous);
        // A refused change may still have saved part of it: read it back.
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
