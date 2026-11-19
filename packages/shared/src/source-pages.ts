import { describeSourceRef } from "./providers";
import type { ProviderId } from "./providers";

const TRAKT_OWN_PAGES = new Map([
  ["me/watchlist", "users/me/watchlist"],
  ["me/favorites", "profile/me/favorites"],
  ["me/ratings", "profile/me?view=activity"],
  ["me/recommendations", "discover/recommended"],
  ["me/up-next", "users/me/progress"],
  ["me/continue-watching", "users/me/progress"],
  ["me/calendar", "calendar"],
  ["me/history", "history"],
]);

/**
 * The Provider's own page of a Source list, to open next to Quick add, or
 * undefined when there is none we can link:
 * - Trakt pages of the user say `me`, as Trakt's own app does: their URLs
 *   need the user's slug, which often differs from the username ("a_b" is
 *   "a-b").
 * - Trakt has no page of a user's whole collection, only one per library.
 * - Simkl's library pages need a numeric user ID that Stremlist does not keep.
 * - MDBList has no public page for a user's watchlist, ratings, history, Up
 *   Next or collection.
 *
 * `username` is the Connection's username, for the pages of a user.
 */
export function sourcePageUrl(
  provider: ProviderId,
  ref: string,
  username: string | null | undefined,
) {
  const known = describeSourceRef(provider, ref).url;
  if (known) return known;
  const user = username ? encodeURIComponent(username) : null;
  if (provider === "trakt") {
    const own = ref.match(/^me\/lists\/(.+)$/);
    const page = own
      ? `users/me/lists/${own[1]}`
      : ref.startsWith("calendars/")
        ? "calendar"
        : TRAKT_OWN_PAGES.get(ref);
    if (page) return `https://app.trakt.tv/${page}`;
  }
  if (provider === "mdblist") {
    if (ref.startsWith("official/") || ref.startsWith("recommended/"))
      return "https://mdblist.com/toplists";
    if (user && /^me\/(lists|external)\//.test(ref))
      return `https://mdblist.com/lists/${user}`;
  }
  return undefined;
}
