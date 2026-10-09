import { useEffect, useRef, useState } from "react";

/**
 * Whether to show a pending state. It appears only when `pending` lasts
 * longer than `delay`, then stays for at least `minDuration`, so a fast
 * request never flashes it.
 */
export function usePendingIndicator(
  pending: boolean,
  delay = 400,
  minDuration = 600,
): boolean {
  const [shown, setShown] = useState(false);
  const shownAt = useRef(0);

  useEffect(() => {
    if (pending && !shown) {
      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        setShown(true);
      }, delay);
      return () => clearTimeout(timer);
    }
    if (!pending && shown) {
      const remaining = shownAt.current + minDuration - Date.now();
      const timer = setTimeout(() => setShown(false), Math.max(0, remaining));
      return () => clearTimeout(timer);
    }
  }, [pending, shown, delay, minDuration]);

  return shown;
}
