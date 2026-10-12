import type { Tables } from "@stremlist/shared/database.types";
import { PROVIDER_IDS } from "@stremlist/shared/providers";
import { z } from "zod";
import { createHash } from "node:crypto";
import { supabase } from "../lib/supabase";

export const connectionIdentitySchema = z.object({
  accountId: z.string(),
  provider: z.enum(PROVIDER_IDS),
  authorization: z.string(),
});

/** Identifies the exact authorization that produced private cached data. */
export type ConnectionIdentity = z.infer<typeof connectionIdentitySchema>;

export function authorizationFingerprint(
  row: Pick<Tables<"connections">, "created_at" | "access_token">,
): string {
  return createHash("sha256")
    .update(`${row.created_at}\0${row.access_token}`)
    .digest("hex");
}

/** Fail closed, including on a database outage; never trust local cleanup. */
export async function isCurrentConnection(
  identity: ConnectionIdentity,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("connections")
    .select("created_at, access_token")
    .eq("account_id", identity.accountId)
    .eq("provider", identity.provider)
    .maybeSingle();
  return (
    !error &&
    !!data &&
    authorizationFingerprint(data) === identity.authorization
  );
}
