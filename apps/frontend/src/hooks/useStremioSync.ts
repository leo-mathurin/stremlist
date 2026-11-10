import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { buildAddonUrls } from "@/lib/list-sources";
import {
  StremioSessionError,
  createLinkCode,
  getStremioEmail,
  installStremlist,
  readLinkCode,
  updateInstalledStremlist,
} from "@/lib/stremio-sync";

/** The linked Stremio account, kept in this browser only. */
export interface StremioConnection {
  authKey: string;
  email: string | null;
}

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

export type StremioSyncState =
  | { kind: "idle" }
  | { kind: "updating" }
  | { kind: "updated" }
  | {
      kind: "failed";
      /** unavailable: retry; signed-out: link again; missing: not installed. */
      reason: "unavailable" | "signed-out" | "missing";
    };

const CONNECTION_KEY = "stremlist:stremio-connection";
const MANUAL_KEY = "stremlist:stremio-manual";
/** How long the member has to confirm a code before it counts as expired. */
const LINK_TIMEOUT_MS = 5 * 60_000;
const LINK_POLL_MS = 2_000;

function readConnection(): StremioConnection | null {
  try {
    const raw = localStorage.getItem(CONNECTION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StremioConnection>;
    return typeof value.authKey === "string" && value.authKey
      ? {
          authKey: value.authKey,
          email: typeof value.email === "string" ? value.email : null,
        }
      : null;
  } catch {
    return null;
  }
}

function writeConnection(value: StremioConnection | null) {
  try {
    if (value) localStorage.setItem(CONNECTION_KEY, JSON.stringify(value));
    else localStorage.removeItem(CONNECTION_KEY);
  } catch {
    // Private mode: the connection lasts until the page closes.
  }
}

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

/**
 * The optional link to the member's Stremio account that lets a save update
 * the installed Stremlist without a reinstall. `onUpToDate` runs when Stremio
 * reads the saved catalogs, which ends the reinstall reminder.
 */
export function useStremioSync(
  accountKey: string | null,
  onUpToDate: () => void,
) {
  const [connection, setConnection] = useState(readConnection);
  const [manualPreferred, setManualPreferredState] = useState(readManual);
  const [link, setLink] = useState<StremioLinkState>({ kind: "idle" });
  const [sync, setSync] = useState<StremioSyncState>({ kind: "idle" });
  const linkRun = useRef(0);
  const onUpToDateRef = useRef(onUpToDate);
  useEffect(() => {
    onUpToDateRef.current = onUpToDate;
  });

  const forget = useCallback(() => {
    writeConnection(null);
    setConnection(null);
  }, []);

  /**
   * Gives Stremio the saved catalogs. A quiet check (on load) stays silent
   * when nothing changed or Stremio does not answer.
   */
  const update = useCallback(
    async (using: StremioConnection | null, quiet = false) => {
      if (!accountKey || !using) return;
      if (!quiet) setSync({ kind: "updating" });
      try {
        const result = await updateInstalledStremlist(
          using.authKey,
          buildAddonUrls(accountKey).addonUrl,
        );
        if (result === "missing") {
          setSync({ kind: "failed", reason: "missing" });
          return;
        }
        onUpToDateRef.current();
        if (!quiet || result === "updated") setSync({ kind: "updated" });
      } catch (err) {
        if (err instanceof StremioSessionError) {
          forget();
          setSync({ kind: "failed", reason: "signed-out" });
        } else if (!quiet) {
          setSync({ kind: "failed", reason: "unavailable" });
        }
      }
    },
    [accountKey, forget],
  );

  /**
   * Links a Stremio account. Opens the Stremio tab at once, inside the click,
   * so a popup blocker lets it through, then points it at the code page.
   */
  const connect = useCallback(async () => {
    const run = ++linkRun.current;
    const tab = window.open("", "_blank");
    setLink({ kind: "waiting", link: null });
    setSync({ kind: "idle" });
    let code;
    try {
      code = await createLinkCode();
    } catch {
      tab?.close();
      if (run !== linkRun.current) return;
      setLink({ kind: "idle" });
      setSync({ kind: "failed", reason: "unavailable" });
      return;
    }
    if (run !== linkRun.current) {
      tab?.close();
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
      let authKey: string | null = null;
      try {
        authKey = await readLinkCode(code.code);
      } catch {
        // A missed answer is not a refusal: ask again.
      }
      if (run !== linkRun.current) return;
      if (authKey) {
        const email = await getStremioEmail(authKey).catch(() => null);
        if (run !== linkRun.current) return;
        const linked = { authKey, email };
        writeConnection(linked);
        writeManual(false);
        setConnection(linked);
        setManualPreferredState(false);
        setLink({ kind: "idle" });
        // The save toast still says how to update Stremio by hand.
        toast.dismiss("configuration-save");
        await update(linked);
        return;
      }
    }
    if (run === linkRun.current) setLink({ kind: "expired" });
  }, [update]);

  const cancelLink = useCallback(() => {
    linkRun.current++;
    setLink({ kind: "idle" });
  }, []);

  /** Forgets the key in this browser. Stremio stays signed in elsewhere. */
  const disconnect = useCallback(() => {
    linkRun.current++;
    forget();
    setLink({ kind: "idle" });
    setSync({ kind: "idle" });
  }, [forget]);

  /** The linked account is the wrong one: forget it, then link another. */
  const switchAccount = useCallback(() => {
    linkRun.current++;
    forget();
    setSync({ kind: "idle" });
    setLink({ kind: "switching" });
  }, [forget]);

  const retry = useCallback(() => update(connection), [update, connection]);

  /** The member asked to add Stremlist back to the linked account. */
  const installAgain = useCallback(async () => {
    if (!accountKey || !connection) return;
    setSync({ kind: "updating" });
    try {
      await installStremlist(
        connection.authKey,
        buildAddonUrls(accountKey).addonUrl,
      );
      onUpToDateRef.current();
      setSync({ kind: "updated" });
    } catch (err) {
      if (err instanceof StremioSessionError) {
        forget();
        setSync({ kind: "failed", reason: "signed-out" });
      } else {
        setSync({ kind: "failed", reason: "unavailable" });
      }
    }
  }, [accountKey, connection, forget]);

  /** The member reinstalled by hand: the last failure no longer applies. */
  const clearStatus = useCallback(() => setSync({ kind: "idle" }), []);

  const setManualPreferred = useCallback((value: boolean) => {
    writeManual(value);
    setManualPreferredState(value);
  }, []);

  // A Stremio app left open can write its older copy of the addon back, so
  // a linked account is checked again each time the page opens.
  const checked = useRef<string | null>(null);
  const check = useCallback(() => {
    if (!accountKey || !connection || checked.current === accountKey) return;
    checked.current = accountKey;
    void update(connection, true);
  }, [accountKey, connection, update]);

  // Stop asking Stremio for a code once the page goes away.
  useEffect(
    () => () => {
      linkRun.current++;
    },
    [],
  );

  return {
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
    update: () => update(connection),
    retry,
    installAgain,
    clearStatus,
    check,
  };
}

export type StremioSync = ReturnType<typeof useStremioSync>;
