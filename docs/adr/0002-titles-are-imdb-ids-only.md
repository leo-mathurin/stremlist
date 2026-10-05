# Titles are IMDb IDs only, with no `tmdb:` fallback

Every Provider adapter must resolve its entries to an IMDb ID (`tt…`). Entries without one are not shown, and Stremlist retries them on later refreshes. We do not emit `tmdb:` IDs, even though some Providers (Letterboxd, JustWatch, SensCritique) give TMDB IDs or no ID at all.

A sample of real data on 2026-10-05 (212 Letterboxd films, 331 JustWatch titles) showed 3.3% and 11.5% of entries without a `tt`. Most of them had a `tt` on IMDb that the Provider had not linked yet; only about 1 to 2% had no IMDb entry at all. The main stream and subtitle addons (Cinemeta, Torrentio, Comet, StremThru Torz, Peerflix, Orion, OpenSubtitles) accept only `tt` and `kitsu`, so a `tmdb:` ID would play for almost nobody. One identity also keeps the cache, the meta route, sorting, RPDB posters and Actions the same for every Provider.

## Consequences

Unresolved entries must not be cached as permanent failures: retrying them is what recovers recent releases and simulcast anime, where the `tt` usually appears days or weeks later.
