import { describeSourceRef } from "./providers";
import type { ProviderId } from "./providers";

const TRAKT_USER_PAGES = new Map([
  ["me/watchlist", "watchlist"],
  ["me/favorites", "favorites"],
  ["me/ratings", "ratings"],
  ["me/history", "history"],
  ["me/collection", "collection"],
  ["me/up-next", "progress"],
  ["me/continue-watching", "progress"],
]);

/**
 * The Provider's own page of a Source list, to open next to Quick add, or
 * undefined when there is none we can link:
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
    if (ref === "me/recommendations")
      return "https://trakt.tv/movies/recommendations";
    if (ref === "me/calendar" || ref.startsWith("calendars/"))
      return "https://app.trakt.tv/calendar";
    if (!user) return undefined;
    const page = TRAKT_USER_PAGES.get(ref);
    if (page) return `https://trakt.tv/users/${user}/${page}`;
    const own = ref.match(/^me\/lists\/(.+)$/);
    if (own) return `https://trakt.tv/users/${user}/lists/${own[1]}`;
  }
  if (provider === "mdblist") {
    if (ref.startsWith("official/") || ref.startsWith("recommended/"))
      return "https://mdblist.com/toplists";
    if (user && /^me\/(lists|external)\//.test(ref))
      return `https://mdblist.com/lists/${user}`;
  }
  return undefined;
}
