import {
  ACCOUNT_ID_PATTERN,
  ACCOUNT_KEY_PATTERN,
} from "@stremlist/shared/constants";
import type { Context } from "hono";
import { z } from "zod";
import { providerParam } from "../../services/account-config";
import type { AccountAccess } from "../../services/accounts";
import { resolveAccountKey } from "../../services/accounts";

/** `/:accountKey/…`: a private Account ID or a Legacy alias. */
export const accountKeyParam = z.object({
  accountKey: z.string().regex(ACCOUNT_KEY_PATTERN),
});

/** `/:accountId/connections/:provider…`: a private Account ID only. */
export const connectionParam = z.object({
  accountId: z.string().regex(ACCOUNT_ID_PATTERN),
  provider: providerParam,
});

type PrivateAccess = AccountAccess & { via: "private" };

function notFound(c: Context, error: string) {
  return c.json({ error }, 404);
}

/** The 404 answer of `requireAccess`. */
type NotFound = ReturnType<typeof notFound>;

/**
 * The Account behind an Addon URL key, or the 404 answer to return. With
 * `privateOnly`, a Legacy alias is not found either: what it asks for needs
 * the private Addon URL (ADR 0001).
 */
export async function requireAccess(
  c: Context,
  key: string,
  options: { privateOnly: true },
): Promise<PrivateAccess | NotFound>;
export async function requireAccess(
  c: Context,
  key: string,
): Promise<AccountAccess | NotFound>;
export async function requireAccess(
  c: Context,
  key: string,
  { privateOnly = false }: { privateOnly?: boolean } = {},
) {
  const access = await resolveAccountKey(key);
  if (privateOnly) {
    return access?.via === "private" ? access : notFound(c, "Addon not found.");
  }
  return access ?? notFound(c, "Addon not found. Install it first.");
}
