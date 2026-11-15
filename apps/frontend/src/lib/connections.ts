import { connectionProviders, listSources } from "@stremlist/shared/list-merge";
import type { MergeableList } from "@stremlist/shared/list-merge";
import { z } from "zod";
import { isProviderId } from "@stremlist/shared/providers";
import type { ProviderId } from "@stremlist/shared/providers";
import type { ConnectionSummary } from "@stremlist/shared/stremio.types";
import type { AccountForm } from "./account-config";
import type { ListSyncState } from "./list-sync";

/** Providers of a List whose Connection the Account does not have. */
export function missingConnections(
  list: MergeableList,
  connections: ConnectionSummary[],
): ProviderId[] {
  return connectionProviders(list).filter(
    (provider) =>
      !connections.some((connection) => connection.provider === provider),
  );
}

/**
 * The Provider that a List row asks to connect: the one of the Connection
 * problem in its sync status (in a merged List, of the Source list with the
 * problem), else the first missing Connection, else the List's Provider.
 */
export function connectProviderOf(
  list: MergeableList,
  sync: ListSyncState | null,
  missing: ProviderId[],
): ProviderId {
  return (
    (sync?.kind === "connection" ? sync.source?.provider : undefined) ??
    missing.at(0) ??
    list.provider
  );
}

/**
 * Identifies the Account's Connections to the Providers of a List's Source
 * lists, or "". It changes when one of them is connected, disconnected,
 * connected again, marked for renewal or working again: then a Catalog
 * preview can read something else.
 */
export function previewConnectionKey(
  list: MergeableList,
  connections: ConnectionSummary[],
): string {
  return [...new Set(listSources(list).map((source) => source.provider))]
    .map((provider) => {
      const connection = connections.find(
        (entry) => entry.provider === provider,
      );
      return connection
        ? `${provider}:${connection.connectedAt}:${connection.username ?? ""}:${connection.needsRenewalSince ?? ""}`
        : "";
    })
    .filter(Boolean)
    .join(",");
}

/** The Account created in this tab, so its Addon URL warning stays visible. */
export const NEW_ACCOUNT_STORAGE = "stremlist:new-account";

/** Unsaved edits, kept across the OAuth round trip of Connect. */
const CONNECT_DRAFT_STORAGE = "stremlist:connect-draft";
/** The connect that this browser started, kept until the Provider answers. */
const CONNECT_START_STORAGE = "stremlist:connect-start";

/**
 * Keep the edits of an Account, or of a new setup (`accountId` null), while
 * the browser is on the Provider's consent page.
 */
export function keepDraft(accountId: string | null, form: AccountForm): void {
  try {
    sessionStorage.setItem(
      CONNECT_DRAFT_STORAGE,
      JSON.stringify({ accountId, form }),
    );
  } catch {
    // Storage is off: the edits are lost, as before.
  }
}

export function dropDraft(): void {
  try {
    sessionStorage.removeItem(CONNECT_DRAFT_STORAGE);
  } catch {
    // Nothing was kept.
  }
}

/** A form that `keepDraft` wrote. Its Lists are the part that must hold. */
function isKeptForm(form: unknown): form is AccountForm {
  return (
    typeof form === "object" &&
    form !== null &&
    "lists" in form &&
    Array.isArray(form.lists)
  );
}

/** The kept edits of this Account or new setup, without taking them. */
export function readDraft(accountId: string | null): AccountForm | null {
  try {
    const raw = sessionStorage.getItem(CONNECT_DRAFT_STORAGE);
    if (!raw) return null;
    const draft: unknown = JSON.parse(raw);
    return typeof draft === "object" &&
      draft !== null &&
      "accountId" in draft &&
      draft.accountId === accountId &&
      "form" in draft &&
      isKeptForm(draft.form)
      ? draft.form
      : null;
  } catch {
    return null;
  }
}

/** The kept edits of this Account or new setup, once: taking forgets them. */
export function takeDraft(accountId: string | null): AccountForm | null {
  const draft = readDraft(accountId);
  dropDraft();
  return draft;
}

/**
 * A connect that this browser started. Only this browser has `browserKey`:
 * the backend completes the authorization only with it, so a consent link
 * that another person opens links nothing.
 */
export interface ConnectStart {
  provider: ProviderId;
  /** The Account to connect, or null for a new setup. */
  accountId: string | null;
  browserKey: string;
}

const storedConnectStart = z.object({
  provider: z.string().refine(isProviderId),
  accountId: z.string().nullable(),
  browserKey: z.string(),
});

export function rememberConnectStart(start: ConnectStart): void {
  try {
    sessionStorage.setItem(CONNECT_START_STORAGE, JSON.stringify(start));
  } catch {
    // Storage is off: the return reports that this browser did not start it.
  }
}

/** The connect this browser started, once: taking it forgets it. */
export function takeConnectStart(): ConnectStart | null {
  try {
    const raw = sessionStorage.getItem(CONNECT_START_STORAGE);
    sessionStorage.removeItem(CONNECT_START_STORAGE);
    if (!raw) return null;
    const start = storedConnectStart.safeParse(JSON.parse(raw));
    return start.success ? start.data : null;
  } catch {
    return null;
  }
}

/** The Provider's answer, as the backend callback puts it in the fragment. */
export interface ConnectAnswer {
  provider: ProviderId;
  state: string;
  code: string | null;
  error: string | null;
}

export function parseConnectAnswer(hash: string): ConnectAnswer | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const provider = params.get("oauth");
  const state = params.get("state");
  if (!provider || !isProviderId(provider) || !state) return null;
  return {
    provider,
    state,
    code: params.get("code"),
    error: params.get("oauth_error"),
  };
}
