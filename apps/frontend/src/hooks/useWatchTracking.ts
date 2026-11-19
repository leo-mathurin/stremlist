import type {
  ActivityKind,
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
  provider: WatchProviderId | null;
  /** It turns automatic marks on: the library is read first. */
  starting: boolean;
}

const TOAST = { id: "watch-tracking" } as const;

const watchTrackingApi = api[":accountId"]["watch-tracking"];

type ChangeAnswer = InferResponseType<typeof watchTrackingApi.$put>;

type RefusalReason = Extract<ChangeAnswer, { reason: string }>["reason"];

function refusal(reason: RefusalReason | undefined) {
  switch (reason) {
    case "consent-required":
      return "Allow activity sharing before turning this on.";
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

async function sendChange(
  accountId: string,
  destinations: WatchProviderId[],
  watchlistDestinations: WatchProviderId[],
  consent: boolean,
) {
  try {
    const res = await watchTrackingApi.$put({
      param: { accountId },
      json: { destinations, watchlistDestinations, consent },
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
  const loadedAccount = useRef(accountId);

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
    if (loadedAccount.current !== accountId) {
      loadedAccount.current = accountId;
      run.current++;
      changing.current = false;
      reloadAfterChange.current = false;
      setStatus(null);
      setBusy(null);
      setNotice(null);
    }
    void load();
  }, [accountId, load, refreshKey]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const save = useCallback(
    async (
      destinations: WatchProviderId[],
      watchlist: WatchProviderId[],
      change: WatchChange,
      consent: boolean,
    ) => {
      if (!accountId || !status || changing.current) return false;
      const previous = status;
      const current = ++run.current;
      changing.current = true;
      setBusy(change);
      setNotice(null);
      setStatus({
        ...status,
        destinations: status.destinations.map((d) => ({
          ...d,
          enabled: destinations.includes(d.provider),
          watchlistEnabled: watchlist.includes(d.provider),
        })),
      });
      const answer = await sendChange(
        accountId,
        destinations,
        watchlist,
        consent,
      );
      const body = answer.saved;
      if (current !== run.current) return false;
      if (body) {
        setStatus(body.status);
        if (body.stremio === "signed-out") onSignedOut();
        if (
          body.status.destinations.some((d) => d.enabled || d.watchlistEnabled)
        ) {
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
        )
          onSignedOut();
      }
      changing.current = false;
      setBusy(null);
      if (reloadAfterChange.current) {
        reloadAfterChange.current = false;
        void load();
      }
      return !!body;
    },
    [accountId, load, onSignedOut, status],
  );
  const toggle = useCallback(
    (
      provider: WatchProviderId,
      enabled: boolean,
      kind: ActivityKind = "watched",
      consent = false,
    ) => {
      if (!status) return Promise.resolve(false);
      const watched = status.destinations
        .filter((d) =>
          kind === "watched" && d.provider === provider ? enabled : d.enabled,
        )
        .map((d) => d.provider);
      const watchlist = status.destinations
        .filter((d) =>
          kind === "watchlist" && d.provider === provider
            ? enabled
            : d.watchlistEnabled,
        )
        .map((d) => d.provider);
      return save(
        watched,
        watchlist,
        {
          provider,
          starting:
            enabled &&
            !status.destinations.some((d) => d.enabled || d.watchlistEnabled),
        },
        consent,
      );
    },
    [save, status],
  );
  const stop = useCallback(
    () => save([], [], { provider: null, starting: false }, false),
    [save],
  );
  const retryWrites = useCallback(async () => {
    if (!accountId || changing.current) return;
    try {
      const res = await watchTrackingApi.retry.$post({ param: { accountId } });
      if (!res.ok) {
        toast.error(
          "Stremlist could not retry these updates. Try again.",
          TOAST,
        );
        return;
      }
      toast.success("Waiting updates will be retried on the next run.", TOAST);
      await load();
    } catch {
      toast.error("Stremlist could not retry these updates. Try again.", TOAST);
    }
  }, [accountId, load]);

  const clearNotice = useCallback(() => setNotice(null), []);

  return {
    status,
    failed,
    busy,
    notice,
    toggle,
    stop,
    retry: load,
    retryWrites,
    clearNotice,
  };
}
