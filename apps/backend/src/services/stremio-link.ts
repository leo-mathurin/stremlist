import type { StremioLink } from "@stremlist/shared/stremio.types";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { supabase } from "../lib/supabase";
import type { AccountAccess } from "./accounts";
import { buildAccountManifest } from "./addon-manifest";
import type { UpdateResult } from "./stremio";
import {
  StremioSessionError,
  StremioUnavailableError,
  getStremioEmail,
  installStremlist,
  readLinkCode,
  updateInstalledStremlist,
} from "./stremio";

/**
 * The Stremio account linked to an Account (ADR 0002). The session key is
 * stored encrypted and never leaves the backend: the configure page only
 * sees the email.
 */

/** The Account has no linked Stremio account (any more). */
export class StremioNotLinkedError extends Error {
  constructor() {
    super("No Stremio account is linked.");
    this.name = "StremioNotLinkedError";
  }
}

export async function getStremioLink(
  accountId: string,
): Promise<StremioLink | null> {
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

/** The stored key, and its ciphertext, which identifies this link. */
async function readKey(
  accountId: string,
): Promise<{ authKey: string; sealed: string }> {
  const { data, error } = await supabase
    .from("stremio_connections")
    .select("auth_key")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw new StremioUnavailableError("Cannot read the Stremio link.");
  if (!data) throw new StremioNotLinkedError();
  try {
    return { authKey: decryptSecret(data.auth_key), sealed: data.auth_key };
  } catch {
    // A key sealed with a retired encryption key: link again.
    await forgetStremioLink(accountId, data.auth_key);
    throw new StremioSessionError();
  }
}

/**
 * Forgets the key. Stremio stays signed in elsewhere (ADR 0002). With
 * `sealed`, only that key: a link made since stays.
 */
export async function forgetStremioLink(
  accountId: string,
  sealed?: string,
): Promise<void> {
  let query = supabase
    .from("stremio_connections")
    .delete()
    .eq("account_id", accountId);
  if (sealed) query = query.eq("auth_key", sealed);
  const { error } = await query;
  if (error) throw error;
}

/**
 * Links the Stremio account that confirmed `code`, or answers null while
 * the member has not confirmed it. A new link replaces the previous one.
 */
export async function linkWithCode(
  accountId: string,
  code: string,
): Promise<StremioLink | null> {
  const authKey = await readLinkCode(code);
  if (!authKey) return null;
  const email = await getStremioEmail(authKey).catch(() => null);
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
  return { email };
}

/** Runs `write` with the stored key; a signed-out key is forgotten. */
async function withKey<T>(
  accountId: string,
  write: (authKey: string) => Promise<T>,
): Promise<T> {
  const { authKey, sealed } = await readKey(accountId);
  try {
    return await write(authKey);
  } catch (error) {
    if (error instanceof StremioSessionError) {
      await forgetStremioLink(accountId, sealed);
    }
    throw error;
  }
}

/**
 * Gives the installed Stremlist the manifest of the last save. The manifest
 * is built when the update runs, so a later save is never undone by an
 * earlier update.
 */
export async function updateStremio(
  access: AccountAccess & { via: "private" },
  addonUrl: string,
): Promise<UpdateResult> {
  return withKey(access.account.id, async (authKey) =>
    updateInstalledStremlist(
      authKey,
      addonUrl,
      await buildAccountManifest(access, access.account.id),
    ),
  );
}

/** Adds Stremlist back to the linked account, on the member's request. */
export async function installInStremio(
  access: AccountAccess & { via: "private" },
  addonUrl: string,
): Promise<void> {
  await withKey(access.account.id, async (authKey) =>
    installStremlist(
      authKey,
      addonUrl,
      await buildAccountManifest(access, access.account.id),
    ),
  );
}
