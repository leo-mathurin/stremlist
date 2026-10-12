import { useNow } from "./useNow";

/**
 * The seconds left before "Refresh now" works again. Only the component that
 * calls it renders each second, so the countdown stays live.
 */
export function useRefreshCooldown(nextRefreshAt: number) {
  const now = useNow();
  const cooldownRemaining = Math.max(
    0,
    Math.ceil((nextRefreshAt - now) / 1000),
  );
  return { cooldownRemaining, onCooldown: cooldownRemaining > 0 };
}
