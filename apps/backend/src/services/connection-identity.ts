import { PROVIDER_IDS } from "@stremlist/shared/providers";
import { z } from "zod";
import { supabase } from "../lib/supabase";

export const connectionIdentitySchema = z.object({
  accountId: z.string(),
  provider: z.enum(PROVIDER_IDS),
  authorization: z.string(),
});

/** Identifies the exact authorization that produced private cached data. */
export type ConnectionIdentity = z.infer<typeof connectionIdentitySchema>;

/** Fail closed, including on a database outage; never trust local cleanup. */
export async function isCurrentConnection(
  identity: ConnectionIdentity,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("connections")
    .select("authorization_version")
    .eq("account_id", identity.accountId)
    .eq("provider", identity.provider)
    .maybeSingle();
  return (
    !error && !!data && data.authorization_version === identity.authorization
  );
}
