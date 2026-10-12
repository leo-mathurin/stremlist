import {
  PROVIDERS,
  parseSourceLink,
  sourceRequiresConnection,
} from "@stremlist/shared/providers";
import { getProvider, isProviderEnabled } from "../providers/registry";
import {
  ConnectionExpiredError,
  SourceUnavailableError,
} from "../providers/types";
import type { AccountAccess } from "./accounts";
import { getConnectionAccess } from "./connections";

/**
 * Detect the Provider behind a pasted link and check that its Source list
 * can be read: the Provider must be available and turned on, and a Source
 * list that only a Connection can read needs one. Only a private Addon URL
 * reads through a Connection (ADR 0001); without `access`, only public
 * Source lists resolve. Expected refusals come back as a reason, never as an
 * error.
 */
export async function resolveSourceLink(
  input: string,
  access: AccountAccess | null,
) {
  const parsed = parseSourceLink(input);
  if (!parsed) {
    return { ok: false as const, reason: "unrecognized" as const };
  }
  const { provider } = parsed;
  const refuse = <R extends string>(reason: R) => ({
    ok: false as const,
    reason,
    provider,
  });
  if (PROVIDERS[provider].availability !== "available") {
    return refuse("coming_soon");
  }
  if (!isProviderEnabled(provider)) return refuse("disabled");

  const connection =
    access?.via === "private"
      ? await getConnectionAccess(access.account.id, provider)
      : null;
  const requiresConnection = sourceRequiresConnection(
    provider,
    parsed.sourceRef,
  );
  if (requiresConnection && !connection) return refuse("needs_connection");

  try {
    const result = await getProvider(provider).validateSource(
      parsed.sourceRef,
      { connection },
    );
    if (!result.ok) return refuse(result.reason);
    return {
      ok: true as const,
      provider,
      sourceRef: result.ref,
      kind: parsed.kind,
      requiresConnection,
      suggestedTitle: result.suggestedTitle ?? parsed.suggestedTitle ?? null,
      defaultDisplayMode: result.defaultDisplayMode ?? null,
    };
  } catch (error) {
    // Expected failures of the Source list: private, missing, refused.
    if (error instanceof SourceUnavailableError) return refuse(error.reason);
    if (error instanceof ConnectionExpiredError) {
      return refuse("needs_connection");
    }
    console.error(
      `Validating ${provider} ${parsed.sourceRef} failed:`,
      error instanceof Error ? error.message : error,
    );
    return refuse("unavailable");
  }
}
