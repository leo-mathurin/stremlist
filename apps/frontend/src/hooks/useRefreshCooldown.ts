import { useEffect, useState } from "react";

/**
 * The seconds left before "Refresh now" works again. While the Account has a
 * last refresh, the page renders once a second, so the "last refreshed"
 * label and the countdown stay live without per-event timers.
 */
export function useRefreshCooldown(
  lastFetchedAt: string | null,
  cooldownSeconds: number,
) {
  const [now, setNow] = useState(() => Date.now());
  const ticking = lastFetchedAt !== null;

  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  const nextRefreshAt = lastFetchedAt
    ? new Date(lastFetchedAt).getTime() + cooldownSeconds * 1000
    : 0;
  const cooldownRemaining = Math.max(
    0,
    Math.ceil((nextRefreshAt - now) / 1000),
  );
  return { cooldownRemaining, onCooldown: cooldownRemaining > 0 };
}
