import { useCallback, useState } from "react";

function hiddenStorageKey(legacyKey: string) {
  return `stremlist:v2-checklist-hidden:${legacyKey}`;
}

function readHidden(legacyKey: string) {
  try {
    return localStorage.getItem(hiddenStorageKey(legacyKey)) === "1";
  } catch {
    return false;
  }
}

function writeHidden(legacyKey: string, hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(hiddenStorageKey(legacyKey), "1");
    else localStorage.removeItem(hiddenStorageKey(legacyKey));
  } catch {}
}

/**
 * Whether the Stremlist 2.0 card of a v1 install (`legacyKey`) is closed in
 * this browser, and a setter that remembers it. Without storage the choice
 * lasts until the page closes.
 */
export function useChecklistHidden(legacyKey: string | null) {
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const hidden = legacyKey
    ? (chosen[legacyKey] ?? readHidden(legacyKey))
    : false;
  const setHidden = useCallback(
    (next: boolean) => {
      if (!legacyKey) return;
      writeHidden(legacyKey, next);
      setChosen((current) => ({ ...current, [legacyKey]: next }));
    },
    [legacyKey],
  );
  return [hidden, setHidden] as const;
}
