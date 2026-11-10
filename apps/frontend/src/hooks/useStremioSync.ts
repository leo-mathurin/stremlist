import type { StremioLink } from "@stremlist/shared/stremio.types";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";

export type StremioLinkState =
  | { kind: "idle" }
  /** Waiting for the member to confirm the code on stremio.com. */
  | { kind: "waiting"; link: string | null }
  | { kind: "expired" }
  /**
   * Before linking another account: a code links the account signed in on
   * stremio.com, so the member changes it there first.
   */
  | { kind: "switching" };

/** unavailable: retry; signed-out: link again; missing: not installed. */
type StremioFailure = "unavailable" | "signed-out" | "missing";

export type StremioSyncState =
  | { kind: "idle" }
  | { kind: "updating" }
  | { kind: "updated" }
  | { kind: "failed"; reason: StremioFailure };

const MANUAL_KEY = "stremlist:stremio-manual";
/** How long the member has to confirm a code before it counts as expired. */
const LINK_TIMEOUT_MS = 5 * 60_000;
const LINK_POLL_MS = 2_000;

function readManual(): boolean {
  try {
    return localStorage.getItem(MANUAL_KEY) === "1";
  } catch {
    return false;
  }
}

function writeManual(value: boolean) {
  try {
    if (value) localStorage.setItem(MANUAL_KEY, "1");
    else localStorage.removeItem(MANUAL_KEY);
  } catch {
    // Private mode: the choice lasts until the page closes.
  }
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Why a Stremio request failed, from the backend's answer. */
function failureOf(res: Response): Exclude<StremioFailure, "missing"> {
  return res.status === 409 ? "signed-out" : "unavailable";
}

/**
 * The optional link to the member's Stremio account that lets a save update
 * the installed Stremlist without a reinstall. The backend keeps the Stremio
 * key (ADR 0002); this page only knows the account's email. Private Account
 * IDs only: `accountId` is null for a Legacy alias or a new setup. `loaded`
 * is the linked account of the loaded configuration. `onUpToDate` runs when
 * Stremio reads the saved catalogs, which ends the reinstall reminder.
 */
export function useStremioSync(
  accountId: string | null,
  loaded: StremioLink | null,
  onUpToDate: () => void,
) {
  // What this page linked or disconnected since the configuration loaded.
  const [changed, setConnection] = useState<StremioLink | null | undefined>(
    undefined,
  );
  const connection = changed === undefined ? loaded : changed;
  const [manualPreferred, setManualPreferredState] = useState(readManual);
  const [link, setLink] = useState<StremioLinkState>({ kind: "idle" });
  const [sync, setSync] = useState<StremioSyncState>({ kind: "idle" });
  const linkRun = useRef(0);
  const onUpToDateRef = useRef(onUpToDate);
  useEffect(() => {
    onUpToDateRef.current = onUpToDate;
  });

  const fail = useCallback((reason: StremioFailure, quiet: boolean) => {
    if (reason === "signed-out") setConnection(null);
    // An outage during the check on load is not worth a card.
    setSync(
      quiet && reason === "unavailable"
        ? { kind: "idle" }
        : { kind: "failed", reason },
    );
  }, []);

  /**
   * Gives Stremio the saved catalogs. A quiet check (on load) stays silent
   * when nothing changed or Stremio does not answer.
   */
  const update = useCallback(
    async (quiet = false) => {
      if (!accountId) return;
      if (!quiet) setSync({ kind: "updating" });
      let res: Response;
      try {
        res = await api[":accountId"].stremio.update.$post({
          param: { accountId },
        });
      } catch {
        fail("unavailable", quiet);
        return;
      }
      if (!res.ok) {
        fail(failureOf(res), quiet);
        return;
      }
      const { result } = (await res.json()) as {
        result: "updated" | "unchanged" | "missing";
      };
      if (result === "missing") {
        fail("missing", quiet);
        return;
      }
      onUpToDateRef.current();
      if (!quiet || result === "updated") setSync({ kind: "updated" });
      else setSync({ kind: "idle" });
    },
    [accountId, fail],
  );

  /**
   * Links a Stremio account. Opens the Stremio tab at once, inside the click,
   * so a popup blocker lets it through, then points it at the code page.
   */
  const connect = useCallback(async () => {
    if (!accountId) return;
    const run = ++linkRun.current;
    const tab = window.open("", "_blank");
    setLink({ kind: "waiting", link: null });
    setSync({ kind: "idle" });
    let code: { code: string; link: string } | null = null;
    try {
      const res = await api[":accountId"].stremio.link.$post({
        param: { accountId },
      });
      if (res.ok) code = (await res.json()) as { code: string; link: string };
    } catch {
      // Handled below, as a refused code.
    }
    if (!code || run !== linkRun.current) {
      tab?.close();
      if (run !== linkRun.current) return;
      setLink({ kind: "idle" });
      setSync({ kind: "failed", reason: "unavailable" });
      return;
    }
    if (tab) {
      tab.opener = null;
      tab.location.href = code.link;
    }
    setLink({ kind: "waiting", link: code.link });

    const deadline = Date.now() + LINK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await wait(LINK_POLL_MS);
      if (run !== linkRun.current) return;
      let linked: StremioLink | null = null;
      try {
        const res = await api[":accountId"].stremio.link[":code"].$post({
          param: { accountId, code: code.code },
        });
        if (res.ok) {
          ({ stremio: linked } = (await res.json()) as {
            stremio: StremioLink | null;
          });
        }
      } catch {
        // A missed answer is not a refusal: ask again.
      }
      if (run !== linkRun.current) return;
      if (linked) {
        writeManual(false);
        setConnection(linked);
        setManualPreferredState(false);
        setLink({ kind: "idle" });
        // The save toast still says how to update Stremio by hand.
        toast.dismiss("configuration-save");
        await update();
        return;
      }
    }
    if (run === linkRun.current) setLink({ kind: "expired" });
  }, [accountId, update]);

  const cancelLink = useCallback(() => {
    linkRun.current++;
    setLink({ kind: "idle" });
  }, []);

  /**
   * Forgets the key on the server. Stremio stays signed in elsewhere: a
   * Stremio logout would also sign the member out of stremio.com.
   */
  const forget = useCallback(async () => {
    if (!accountId) return false;
    try {
      const res = await api[":accountId"].stremio.$delete({
        param: { accountId },
      });
      if (!res.ok) throw new Error("Not disconnected");
    } catch {
      toast.error("Could not disconnect Stremio. Please try again.");
      return false;
    }
    setConnection(null);
    setSync({ kind: "idle" });
    return true;
  }, [accountId]);

  const disconnect = useCallback(async () => {
    linkRun.current++;
    setLink({ kind: "idle" });
    await forget();
  }, [forget]);

  /** The linked account is the wrong one: forget it, then link another. */
  const switchAccount = useCallback(async () => {
    linkRun.current++;
    if (await forget()) setLink({ kind: "switching" });
  }, [forget]);

  const retry = useCallback(() => update(), [update]);

  /** The member asked to add Stremlist back to the linked account. */
  const installAgain = useCallback(async () => {
    if (!accountId) return;
    setSync({ kind: "updating" });
    try {
      const res = await api[":accountId"].stremio.install.$post({
        param: { accountId },
      });
      if (!res.ok) {
        fail(failureOf(res), false);
        return;
      }
    } catch {
      fail("unavailable", false);
      return;
    }
    onUpToDateRef.current();
    setSync({ kind: "updated" });
  }, [accountId, fail]);

  /** The member reinstalled by hand: the last failure no longer applies. */
  const clearStatus = useCallback(() => setSync({ kind: "idle" }), []);

  const setManualPreferred = useCallback((value: boolean) => {
    writeManual(value);
    setManualPreferredState(value);
  }, []);

  // A Stremio app left open can write its older copy of the addon back, so
  // the install is checked once each time the page opens.
  const checked = useRef<string | null>(null);
  useEffect(() => {
    if (!accountId || !loaded || checked.current === accountId) return;
    checked.current = accountId;
    void update(true);
  }, [accountId, loaded, update]);

  // Stop asking for a code once the page goes away.
  useEffect(
    () => () => {
      linkRun.current++;
    },
    [],
  );

  return {
    /** Null for a Legacy alias or a new setup: only the reinstall works. */
    available: accountId !== null,
    connection,
    manualPreferred,
    setManualPreferred,
    link,
    sync,
    connect,
    cancelLink,
    disconnect,
    switchAccount,
    /** Updates Stremio after a save. */
    update: () => update(),
    retry,
    installAgain,
    clearStatus,
  };
}

export type StremioSync = ReturnType<typeof useStremioSync>;
