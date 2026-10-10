import { useEffect, useRef, useState } from "react";

const DELAY_MS = 400;
const MIN_DURATION_MS = 600;

/**
 * Whether to show a pending state. It appears only when `pending` lasts
 * longer than `DELAY_MS`, then stays for at least `MIN_DURATION_MS`, so a
 * fast request never flashes it.
 */
export function usePendingIndicator(pending: boolean): boolean {
  const [shown, setShown] = useState(false);
  const shownAt = useRef(0);

  useEffect(() => {
    if (pending && !shown) {
      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        setShown(true);
      }, DELAY_MS);
      return () => clearTimeout(timer);
    }
    if (!pending && shown) {
      const remaining = shownAt.current + MIN_DURATION_MS - Date.now();
      const timer = setTimeout(() => setShown(false), Math.max(0, remaining));
      return () => clearTimeout(timer);
    }
  }, [pending, shown]);

  return shown;
}
