const RESET = /\bECONNRESET\b/;
const MAX_CAUSES = 5;

function namesReset(value: unknown) {
  if (typeof value === "string") return RESET.test(value);
  if (typeof value !== "object" || value === null) return false;
  if ("code" in value && value.code === "ECONNRESET") return true;
  return (
    "message" in value &&
    typeof value.message === "string" &&
    RESET.test(value.message)
  );
}

/**
 * Whether a failed request lost its connection to a reset. A reset says
 * nothing about the service: a pooled keep-alive socket that the server
 * closed gives one. Bun puts the code on the fetch error and in its
 * message, Node on its `cause`, and Supabase copies the message. An
 * adapter error that wraps the reset (as its `cause`) is a reset too.
 */
export function isConnectionReset(error: unknown) {
  let value = error;
  for (let depth = 0; depth <= MAX_CAUSES; depth += 1) {
    if (namesReset(value)) return true;
    if (typeof value !== "object" || value === null || !("cause" in value))
      return false;
    value = value.cause;
  }
  return false;
}

/**
 * The message of a failed read, for a probe or canary result. When a reset
 * hides behind a wrapping error, the message names it, so the list checks
 * can tell the reset from a failure after the result is saved as text.
 */
export function failureMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  return isConnectionReset(error) && !RESET.test(message)
    ? `${message} (ECONNRESET)`
    : message;
}
