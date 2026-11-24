import { useCallback, useState } from "react";
import { z } from "zod";
import type { ConfigList } from "@stremlist/shared/stremio.types";
import type { NewTitlesForm } from "../lib/new-titles";
import { reinstallState, requiresReinstall } from "../lib/reinstall";
import type { InstallBaseline } from "../lib/reinstall";
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

function installedStorageKey(accountKey: string) {
  return `stremlist:installed:${accountKey}`;
}

const storedBaseline = z.object({
  signature: z.string(),
  actionsLive: z.boolean(),
});

function readInstalled(accountKey: string) {
  try {
    const raw = localStorage.getItem(installedStorageKey(accountKey));
    if (!raw) return null;
    const value = storedBaseline.safeParse(JSON.parse(raw));
    return value.success ? value.data : null;
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
  } catch {}
}

/** A setup as far as Stremio reads it at install time. */
export interface InstallSetup {
  rows: SignatureRow[];
  newTitles: NewTitlesForm;
  /** Actions add a `stream` resource to the manifest. */
  actionsLive: boolean;
  /** Catalog names start with "Stremlist". */
  catalogNamePrefix: boolean;
}

function baselineOf(setup: InstallSetup, genres: KnownSourceGenres | null) {
  return {
    signature: getListReinstallSignature(setup.rows, genres, {
      newTitles: setup.newTitles.enabled,
      newTitlesSettings: setup.newTitles.settings,
      catalogNamePrefix: setup.catalogNamePrefix,
    }),
    actionsLive: setup.actionsLive,
  };
}

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
  const [knownGenres, setKnownGenres] = useState<KnownSourceGenres | null>(
    null,
  );

  const reset = useCallback(() => {
    setInstalled(UNKNOWN_BASELINE);
    setSaved(UNKNOWN_BASELINE);
  }, []);

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

  const onSaved = (key: string, lists: AnswerLists, setup: InstallSetup) => {
    const genres = learnSourceGenres(knownGenres, lists);
    setKnownGenres(genres);
    const nowSaved = baselineOf(setup, genres);
    const needsReinstall = requiresReinstall(installed, nowSaved);
    setSaved(nowSaved);
    writeInstalled(key, needsReinstall ? installed : null);
    return { needsReinstall };
  };

  const markReinstalled = () => {
    setInstalled(saved);
    if (accountKey) writeInstalled(accountKey, null);
  };

  const stateFor = (current: InstallSetup) =>
    reinstallState(installed, saved, baselineOf(current, knownGenres));

  return { reset, onLoaded, onSaved, markReinstalled, stateFor };
}
