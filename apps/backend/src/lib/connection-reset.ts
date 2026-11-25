const RESET = /\bECONNRESET\b/;

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
 * message, Node on its `cause`, and Supabase copies the message.
 */
export function isConnectionReset(error: unknown) {
  return (
    namesReset(error) ||
    (typeof error === "object" &&
      error !== null &&
      "cause" in error &&
      namesReset(error.cause))
  );
}
