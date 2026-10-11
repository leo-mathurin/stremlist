import { useCallback, useState } from "react";
import type { ConfigList } from "@stremlist/shared/stremio.types";
import { reinstallState, requiresReinstall } from "../lib/reinstall";
import type { InstallBaseline, ReinstallState } from "../lib/reinstall";
import {
  getListReinstallSignature,
  learnSourceGenres,
} from "../lib/reinstall-signature";
import type {
  KnownSourceGenres,
  SignatureRow,
} from "../lib/reinstall-signature";

const UNKNOWN_BASELINE: InstallBaseline = {
  signature: null,
  actionsLive: null,
};

/**
 * What Stremio read at the last install, kept per Account while a reinstall
 * is pending, so the reminder survives a reload.
 */
function installedStorageKey(accountKey: string) {
  return `stremlist:installed:${accountKey}`;
}

function readInstalled(accountKey: string): InstallBaseline | null {
  try {
    const raw = localStorage.getItem(installedStorageKey(accountKey));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<InstallBaseline>;
    return typeof value.signature === "string" &&
      typeof value.actionsLive === "boolean"
      ? { signature: value.signature, actionsLive: value.actionsLive }
      : null;
  } catch {
    return null;
  }
}

function writeInstalled(accountKey: string, value: InstallBaseline | null) {
  try {
    if (value) {
      localStorage.setItem(
        installedStorageKey(accountKey),
        JSON.stringify(value),
      );
    } else {
      localStorage.removeItem(installedStorageKey(accountKey));
    }
  } catch {
    // Private mode: the reminder lasts until the page closes.
  }
}

/** A setup as far as Stremio reads it at install time. */
export interface InstallSetup {
  rows: SignatureRow[];
  newTitles: boolean;
  /** Actions add a `stream` resource to the manifest. */
  actionsLive: boolean;
}

function baselineOf(
  setup: InstallSetup,
  genres: KnownSourceGenres | null,
): { signature: string; actionsLive: boolean } {
  return {
    signature: getListReinstallSignature(setup.rows, genres, {
      newTitles: setup.newTitles,
    }),
    actionsLive: setup.actionsLive,
  };
}

/** The Lists of a server answer, with the genres of their Source lists. */
type AnswerLists = Pick<
  ConfigList,
  "provider" | "sourceRef" | "mergedSources" | "sourceGenres"
>[];

/**
 * Whether Stremio must read the manifest again: what it read at the last
 * install, what the last save serves, and the genres of each Source list
 * that the server told. They differ until the user reinstalls. Unknown
 * until the configuration loads; the signature is "" for an Account without
 * Lists.
 */
export function useReinstallBaseline(accountKey: string | null) {
  const [installed, setInstalled] = useState<InstallBaseline>(UNKNOWN_BASELINE);
  const [saved, setSaved] = useState<InstallBaseline>(UNKNOWN_BASELINE);
  // Null until an answer gives genres by Source list (see learnSourceGenres).
  const [knownGenres, setKnownGenres] = useState<KnownSourceGenres | null>(
    null,
  );

  /** Forget the baselines while another configuration loads. */
  const reset = useCallback(() => {
    setInstalled(UNKNOWN_BASELINE);
    setSaved(UNKNOWN_BASELINE);
  }, []);

  /** The configuration loaded: it is what the last save serves. */
  const onLoaded = useCallback(
    (key: string, lists: AnswerLists, setup: InstallSetup) => {
      const genres = learnSourceGenres(null, lists);
      setKnownGenres(genres);
      const loaded = baselineOf(setup, genres);
      setSaved(loaded);
      setInstalled(readInstalled(key) ?? loaded);
    },
    [],
  );

  /**
   * A save stored `setup`. Returns what it serves now and whether Stremio
   * must reinstall to read it: compared with what Stremio read at install
   * time, not with the last save, since a reinstall stays needed until the
   * user does it.
   */
  const onSaved = (key: string, lists: AnswerLists, setup: InstallSetup) => {
    const genres = learnSourceGenres(knownGenres, lists);
    setKnownGenres(genres);
    const nowSaved = baselineOf(setup, genres);
    const needsReinstall = requiresReinstall(installed, nowSaved);
    setSaved(nowSaved);
    writeInstalled(key, needsReinstall ? installed : null);
    return { nowSaved, needsReinstall };
  };

  /** The user reinstalled: Stremio now reads the saved setup. */
  const markReinstalled = (baseline: InstallBaseline = saved) => {
    setInstalled(baseline);
    if (accountKey) writeInstalled(accountKey, null);
  };

  /** Whether the current setup asks for a reinstall, now or once saved. */
  const stateFor = (current: InstallSetup): ReinstallState =>
    reinstallState(installed, saved, baselineOf(current, knownGenres));

  return { reset, onLoaded, onSaved, markReinstalled, stateFor };
}
