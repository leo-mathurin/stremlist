import { useEffect } from "react";
import { useBlocker } from "react-router";

/**
 * While `active`, ask before the user leaves the page: the browser asks
 * before a reload, a closed tab or another site, and the returned blocker
 * holds a move to another page of the app until the user decides. A change
 * of the query only (another Account, an OAuth result) is not held.
 */
export function useLeaveGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const ask = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers need `returnValue` to show the prompt.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [active]);

  return useBlocker(
    ({ currentLocation, nextLocation }) =>
      active && currentLocation.pathname !== nextLocation.pathname,
  );
}
