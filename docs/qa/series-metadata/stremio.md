# Stremio real browser adversarial E2E

Run on this Mac, 2026-09-14, against the user's existing public production setup `ur195879360`. No production configuration/list/database changes. Isolated anonymous Stremio browser profiles, checked `profile.auth` is absent before manipulating addon order.

Production manifest: https://api.stremlist.com/ur195879360/manifest.json (1.9.0; catalog plus movie and series meta).
Production watchlist series catalog: `wl-254e7e07-e90d-4938-8f60-be176f4dfe1d-series`.

## Baseline

- Installed production addon through the real web.stremio.com addon installation dialog, navigated Discover > Series > Stremlist Watchlist > For All Mankind > Show.
- Default Cinemeta-first addon order: Season 1 and ten numbered episodes visible. Clicked Red Moon and He Built the Saturn V; routes select `tt7772588:1:1` and `tt7772588:1:2`. WatchHub displayed Apple TV subscription providers. Actual playback/purchase was not attempted.
- Reordered only the anonymous local browser profile so Stremlist comes before Cinemeta; reloaded. For All Mankind now has no seasons/episode picker; displays abbreviated production IMDb metadata and direct providers.
- Independent title Attack on Titan (`tt2560140`) also loses all episode controls with Stremlist first.
- Movie control The Godfather (`tt0068646`) from the actual watchlist displays title, runtime 2h55, 1972, IMDb summary and providers.

## Candidate

Actual changed local meta route and BASE_MANIFEST served at http://127.0.0.1:7401/ur195879360/manifest.json by another agent's bridge. Catalogs and movie metadata read through to production. Candidate was not deployed to production.

HTTPS browser local-network access stalled, so used the installed native Stremio server's real web proxy at http://127.0.0.1:11470/proxy/d=https%3A%2F%2Fweb.stremio.com/ in a separate anonymous browser profile. Candidate addon installed via UI; Stremlist deliberately ordered first.

- Fresh candidate manifest (movie-only meta): For All Mankind renders Season 1, ten episodes. Actual UI clicks select `tt7772588:1:1` and `tt7772588:1:2`.
- Stale-manifest condition: changed only locally cached addon resource types back to `[movie, series]`, kept candidate endpoint and Stremlist first. Reloaded; verified cached manifest still advertises series. For All Mankind falls back to full Cinemeta episodes.
- Candidate watchlist catalog > Attack on Titan > Show: Season 1 and 25 numbered episodes, including episode dates.
- Movie control retains The Godfather metadata/runtime/providers identical to production baseline.
- Negative control: removing Cinemeta from only the anonymous test profile yields `No metadata was found!` and `No videos found for this meta!`. Profile restored immediately. Delegation requires an available series metadata provider.
- Same-origin A/B control: in the identical anonymous HTTP-proxy Stremio profile, retained stale movie+series manifest and Stremlist-first order; changed only transport URL from candidate to production and reloaded. Episodes disappeared. Restored candidate transport URL and reloaded; ten Season 1 episodes returned. This rules out switching Stremio origin/profile as the cause of the fix.
- Bridge owner confirmed actual `/meta/series/tt7772588.json` requests reached the changed local series guard during stale-manifest testing.

## Evidence paths

- /tmp/stremio-prod-for-all-mankind-episodes.png
- /tmp/stremio-prod-for-all-mankind-s1e1.png
- /tmp/stremio-prod-stremlist-first-no-episodes.png
- /tmp/stremio-prod-stremlist-first-attack-no-episodes.png
- /tmp/stremio-prod-movie-godfather.png
- /tmp/stremio-candidate-stremlist-first-episodes.png
- /tmp/stremio-candidate-stale-manifest-episodes.png
- /tmp/stremio-candidate-attack-episodes.png
- /tmp/stremio-candidate-movie-godfather.png
- /tmp/stremio-candidate-without-metadata-provider.png
- stremio-before.png
- stremio-after.png

## Conclusion

The defect is not exclusive to Nuvio. Production Stremio also fails when Stremlist wins metadata precedence. Default Cinemeta-first ordering masks the problem. Movie-only meta plus series null fallback fixes real Stremio rendering and episode selection for both newly loaded and stale installed manifests. This report does not claim native Nuvio validation or actual video playback.
