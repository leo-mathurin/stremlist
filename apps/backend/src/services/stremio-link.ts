import { randomUUID } from "node:crypto";
import { scheduleBackgroundTask } from "../lib/background";
import {
  EncryptionKeyError,
  decryptSecret,
  encryptSecret,
  hasValidSignature,
  signValue,
} from "../lib/crypto";
import { supabase } from "../lib/supabase";
import { resolveAccountKey } from "./accounts";
import { buildAccountManifest } from "./addon-manifest";
import {
  StremioSessionError,
  StremioUnavailableError,
  createLinkCode,
  getStremioEmail,
  installStremlist,
  readLinkCode,
  updateInstalledStremlist,
} from "./stremio";
import { invalidateWatchBaseline, retakeWatchBaseline } from "./watch/tracking";

/** The Account has no linked Stremio account (any more). */
export class StremioNotLinkedError extends Error {
  constructor() {
    super("No Stremio account is linked.");
    this.name = "StremioNotLinkedError";
  }
}

export async function getStremioLink(accountId: string) {
  const { data, error } = await supabase
    .from("stremio_connections")
    .select("email")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) {
    console.error(`Failed to read the Stremio link of ${accountId}:`, error);
    return null;
  }
  return data ? { email: data.email } : null;
}

async function readKey(accountId: string) {
  const { data, error } = await supabase
    .from("stremio_connections")
    .select("auth_key")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw new StremioUnavailableError("Cannot read the Stremio link.");
  if (!data) throw new StremioNotLinkedError();
  try {
    return { authKey: decryptSecret(data.auth_key), sealed: data.auth_key };
  } catch (error) {
    if (error instanceof EncryptionKeyError) throw error;
    await forgetStremioLink(accountId, data.auth_key);
    throw new StremioSessionError();
  }
}

async function forgetStremioLink(accountId: string, sealed?: string) {
  let query = supabase
    .from("stremio_connections")
    .delete()
    .eq("account_id", accountId);
  if (sealed) query = query.eq("auth_key", sealed);
  const { error } = await query;
  if (error) throw error;
}

const LINK_TOKEN_PURPOSE = "stremio-link";
const LINK_TOKEN_TTL_MS = 10 * 60_000;

/** The code was not issued to this Account, or is too old. */
export class StremioLinkTokenError extends Error {
  constructor() {
    super("This Stremio code is not valid for this Account.");
    this.name = "StremioLinkTokenError";
  }
}

/**
 * A code for the member to confirm on Stremio's page, and a token that only
 * this Account can use to ask about it. The code itself never goes in a URL
 * of Stremlist, so request logs do not keep it.
 */
export async function startStremioLink(accountId: string) {
  const { code, link } = await createLinkCode();
  const expiresAt = Date.now() + LINK_TOKEN_TTL_MS;
  const payload = `${code}.${expiresAt}`;
  const signature = signValue(LINK_TOKEN_PURPOSE, `${accountId}.${payload}`);
  return { link, token: `${payload}.${signature}` };
}

function codeOf(accountId: string, token: string) {
  const [code, expiresAt, signature, ...rest] = token.split(".");
  if (rest.length > 0 || !code || !expiresAt || !signature) {
    throw new StremioLinkTokenError();
  }
  const valid = hasValidSignature(
    LINK_TOKEN_PURPOSE,
    `${accountId}.${code}.${expiresAt}`,
    signature,
  );
  if (!valid || Number(expiresAt) < Date.now()) {
    throw new StremioLinkTokenError();
  }
  return code;
}

/**
 * Links the Stremio account that confirmed the code of `token`, or answers
 * null while the member has not confirmed it. A new link replaces the
 * previous one.
 */
export async function linkWithToken(accountId: string, token: string) {
  const authKey = await readLinkCode(codeOf(accountId, token));
  if (!authKey) return null;
  const email = await getStremioEmail(authKey).catch(() => null);
  const tracked = await invalidateWatchBaseline(accountId).catch(
    (error: unknown) => {
      throw new StremioUnavailableError(
        error instanceof Error ? error.message : "Cannot reset Watch tracking.",
      );
    },
  );
  const { error } = await supabase.from("stremio_connections").upsert(
    {
      account_id: accountId,
      auth_key: encryptSecret(authKey),
      email,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "account_id" },
  );
  if (error) throw new StremioUnavailableError("Cannot save the Stremio link.");
  if (tracked) scheduleBackgroundTask(() => retakeWatchBaseline(accountId));
  return { email };
}

const UPDATE_LEASE_SECONDS = 45;
const UPDATE_WAIT_MS = 25_000;
const UPDATE_RETRY_MS = 250;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withUpdateLease<T>(accountId: string, write: () => Promise<T>) {
  const token = randomUUID();
  const deadline = Date.now() + UPDATE_WAIT_MS;
  for (;;) {
    const { data, error } = await supabase.rpc("claim_stremio_update", {
      p_account_id: accountId,
      p_lease_seconds: UPDATE_LEASE_SECONDS,
      p_lease_token: token,
    });
    if (error) throw new StremioUnavailableError("Cannot lock the update.");
    if (data === "none") throw new StremioNotLinkedError();
    if (data === "claimed") break;
    if (Date.now() >= deadline) {
      throw new StremioUnavailableError("Another update is still running.");
    }
    await sleep(UPDATE_RETRY_MS);
  }
  try {
    return await write();
  } finally {
    const { error } = await supabase.rpc("release_stremio_update", {
      p_account_id: accountId,
      p_lease_token: token,
    });
    if (error) console.error("Failed to release the Stremio update:", error);
  }
}

async function withKey<T>(
  accountId: string,
  write: (authKey: string) => Promise<T>,
) {
  return withUpdateLease(accountId, async () => {
    const { authKey, sealed } = await readKey(accountId);
    try {
      return await write(authKey);
    } catch (error) {
      if (error instanceof StremioSessionError) {
        await forgetStremioLink(accountId, sealed);
      }
      throw error;
    }
  });
}

async function latestManifest(accountId: string) {
  const access = await resolveAccountKey(accountId);
  if (access?.via !== "private") throw new StremioNotLinkedError();
  return buildAccountManifest(access, accountId);
}

/** Gives the installed Stremlist the manifest of the last save. */
export async function updateStremio(accountId: string, addonUrl: string) {
  return withKey(accountId, async (authKey) =>
    updateInstalledStremlist(
      authKey,
      addonUrl,
      await latestManifest(accountId),
    ),
  );
}

/** Adds Stremlist back to the linked account, on the member's request. */
export async function installInStremio(accountId: string, addonUrl: string) {
  await withKey(accountId, async (authKey) =>
    installStremlist(authKey, addonUrl, await latestManifest(accountId)),
  );
}

/**
 * Disconnects Stremio. Waits for a running update, so its write cannot
 * land after the member links Stremio again. An update that holds the lease
 * past the wait (a stopped server, or a very slow Stremio) does not keep the
 * member from disconnecting.
 */
export async function disconnectStremio(accountId: string) {
  try {
    await withUpdateLease(accountId, () => forgetStremioLink(accountId));
  } catch (error) {
    if (error instanceof StremioNotLinkedError) return;
    if (!(error instanceof StremioUnavailableError)) throw error;
    await forgetStremioLink(accountId);
  }
}
