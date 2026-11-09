import {
  SOURCE_LINK_MAX_LENGTH,
  SOURCE_REF_MAX_LENGTH,
} from "@stremlist/shared/constants";
import { QUEUE_STATE_MIN_MS } from "@stremlist/shared/provider-queue";
import type { QueuedAnswer } from "@stremlist/shared/provider-queue";
import {
  PROVIDERS,
  parseSourceLink,
  sourceRequiresConnection,
} from "@stremlist/shared/providers";
import type { ProviderId } from "@stremlist/shared/providers";
import { mayReadProvider } from "../providers/availability";
import { readQueue, withReadPriority } from "../providers/read-priority";
import { getProvider } from "../providers/registry";
import {
  ConnectionExpiredError,
  SourceBusyError,
  SourceUnavailableError,
} from "../providers/types";
import type { AccountAccess } from "./accounts";
import { getConnectionAccess } from "./connections";

/** A check waits this long at most in the Provider's queue. */
const CHECK_WAIT_MS = 10_000;

/** The answer of a read that waits its turn in the Provider's queue. */
export function queuedAnswer(
  error: SourceBusyError,
  provider: ProviderId,
): QueuedAnswer {
  return {
    ok: false,
    reason: "queued",
    provider,
    waitMs: error.waitMs,
    retryMs: error.retryMs ?? Math.min(error.waitMs, 5_000),
    ticket: error.ticket,
  };
}

/**
 * Detect the Provider behind a pasted link and check that its Source list
 * can be read: the Provider must be available and turned on, and a Source
 * list that only a Connection can read needs one. Only a private Addon URL
 * reads through a Connection (ADR 0001); without `access`, only public
 * Source lists resolve. Expected refusals come back as a reason, never as an
 * error. When the Provider's queue is long (3 s or more), the answer is the
 * queue state: ask again with its `ticket` to keep the place. A link longer
 * than the stored reference allows is refused before any read ("too_long"),
 * so every link that passes the check can be previewed and saved.
 */
export async function resolveSourceLink(
  input: string,
  access: AccountAccess | null,
  ticket: string | null = null,
) {
  if (input.trim().length > SOURCE_LINK_MAX_LENGTH) {
    return { ok: false as const, reason: "too_long" as const };
  }
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
  if (!(await mayReadProvider(provider))) return refuse("disabled");

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
    const result = await withReadPriority(
      "interactive",
      () =>
        getProvider(provider).validateSource(parsed.sourceRef, { connection }),
      readQueue({
        maxWaitMs: CHECK_WAIT_MS,
        answerAtMs: QUEUE_STATE_MIN_MS,
        ticket,
      }),
    );
    if (!result.ok) return refuse(result.reason);
    // Only a redirect (a boxd.it link) can make a reference this long.
    if (result.ref.length > SOURCE_REF_MAX_LENGTH) {
      return { ok: false as const, reason: "too_long" as const };
    }
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
    if (error instanceof SourceBusyError) return queuedAnswer(error, provider);
    // Expected failures of the Source list: private, missing, refused.
    if (error instanceof SourceUnavailableError) return refuse(error.reason);
    if (error instanceof ConnectionExpiredError) {
      return refuse("needs_connection");
    }
    // Never log the raw reference: a Share link reference carries a secret token.
    console.error(
      `Validating a ${provider} source failed:`,
      error instanceof Error ? error.message : error,
    );
    return refuse("unavailable");
  }
}
