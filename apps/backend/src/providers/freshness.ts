const ownMinutes = Number(process.env.CACHE_TTL_MINUTES);

/**
 * How long a cached Catalog of the user's own Source list (watchlist, own
 * lists, ratings, history, library) stays fresh, on every Provider that can
 * tell it apart. `CACHE_TTL_MINUTES` overrides it. A refresh still happens
 * only when Stremio asks for a stale Catalog.
 */
export const OWN_LIST_FRESHNESS_MS =
  (Number.isFinite(ownMinutes) && ownMinutes > 0 ? ownMinutes : 10) * 60_000;

/**
 * How long a cached Catalog of a chart or of another user's public list
 * stays fresh. Providers read without a Connection or on a shared request
 * budget (Letterboxd, JustWatch, SensCritique) use it for every Source list.
 */
export const SHARED_LIST_FRESHNESS_MS = 6 * 60 * 60_000;
