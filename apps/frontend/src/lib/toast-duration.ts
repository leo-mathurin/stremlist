const HOLD_TOASTS_KEY = "stremlist:hold-toasts";

function holdsToasts() {
  try {
    return sessionStorage.getItem(HOLD_TOASTS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * How long a toast stays on screen: `ms`, or until it is replaced or closed
 * when the session holds toasts (browser tests that check a toast long after
 * it opened).
 */
export function toastDuration(ms: number) {
  return holdsToasts() ? Number.POSITIVE_INFINITY : ms;
}
