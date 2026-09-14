# Series metadata compatibility — 2026-09-14

The production defect was reproduced in both Stremio and Nuvio on this Mac.
Restricting Stremlist's `meta` resource to movies and returning `{ "meta": null }`
for series restores episode selection when another series metadata provider is
installed. Keeping movie metadata avoids removing the existing fallback for
movies absent from Cinemeta.

## Scope

- Production: `https://api.stremlist.com/ur195879360/manifest.json`, version 1.9.0.
- Existing IMDb watchlist and its production catalog configuration were used.
- Nuvio: official macOS arm64 0.1.22-alpha, released September 1, before the report.
- Stremio: hosted Web UI; candidate and same-origin A/B tests also used the real
  Web UI through the installed Stremio 5.1.27 HTTP proxy. Separate anonymous
  browser profiles prevented changes to the user's installed addon order.
- Native Stremio's existing user profile was inspected separately. It points to
  a staging Stremlist URL and already displays episodes with its current order;
  that observation is not counted as a production failure/fix comparison.
- Candidate: loopback HTTP bridge at port 7401, bundling the actual changed
  `routes/meta.ts` and `BASE_MANIFEST`. Production supplies unchanged catalogs
  and movie metadata; the cache dependency is replaced by read-through GETs.
  This exercises the changed route and manifest, not the complete local
  database/cache stack and not a production deployment.
- No video playback was attempted. A loopback stream observer at port 7402
  returned an empty stream list and recorded which video IDs Nuvio requested.

## Results

| Client / condition                                     | Observed result                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Stremio production, Cinemeta first                     | For All Mankind: season 1, ten episodes, S1E1/S1E2 selectable                               |
| Stremio production, Stremlist first                    | For All Mankind and Attack on Titan lose episode controls                                   |
| Stremio candidate, Stremlist first                     | Both series regain numbered episodes; correct S1E1/S1E2 IDs                                 |
| Stremio candidate with old manifest advertising series | Actual series route receives requests and null fallback restores episodes                   |
| Stremio same-profile A/B, change endpoint only         | Production removes episodes; candidate restores them                                        |
| Stremio movie control                                  | The Godfather retains title, 1972, 2h55, description and providers                          |
| Stremio candidate without Cinemeta                     | No metadata, confirming the external-provider dependency                                    |
| Nuvio production, Stremlist first                      | For All Mankind: one Play button, no seasons/episodes                                       |
| Nuvio candidate, same order after restart              | Five seasons, Specials and episode cards; Play S1E1                                         |
| Nuvio candidate episode selection                      | S1E2 and S2E1 labels and matching stream requests                                           |
| Nuvio repeat production with same observer             | Defect returns; Play requests base series ID rather than an episode                         |
| Nuvio candidate movie control                          | The Godfather retains title, runtime, description and the same movie stream ID              |
| Nuvio candidate second series                          | Attack on Titan: four seasons plus Specials; S1E2 selection requests the correct episode ID |

Nuvio's disposable anonymous profile was seeded through its local configuration
files because the automation tool could click but could not enter text into
Compose fields. The application fetched real addon manifests and catalogs;
all series navigation, season selection and episode selection used the real
native UI. Nuvio was restarted between endpoint variants to clear its in-memory
metadata cache.

Observed HTTP requests from Nuvio, URL-decoded:

```text
candidate: /stream/series/tt7772588:1:2.json
candidate: /stream/series/tt7772588:2:1.json
production repeat: /stream/series/tt7772588.json
production movie control: /stream/movie/tt0068646.json
candidate movie control: /stream/movie/tt0068646.json
candidate second series: /stream/series/tt2560140:1:2.json
```

## Adversarial review findings

Addon order can hide the defect. A default Cinemeta-first success is insufficient
evidence. A stale installed manifest can continue directing series requests to
Stremlist, so changing the manifest alone is insufficient; the series route must
also decline those requests. Positive client metadata caches can preserve old
results; restart/refresh may be needed when validating a rollout.

The correction delegates series metadata; it does not create episode data.
Series absent from every installed metadata provider will not gain a playable
detail page. This limitation was demonstrated with the no-Cinemeta control.
Nuvio TV source was reviewed, but no TV build was executed; runtime conclusions
here apply to the tested desktop clients.

## Verification

Regression tests were first run against the old implementation: three failed.
After the change all ten focused tests and all 133 backend tests passed. Backend
build, TypeScript checking, ESLint and `git diff --check` passed.

```sh
pnpm --filter @stremlist/backend test
pnpm --filter @stremlist/backend build
pnpm --filter @stremlist/backend typecheck
pnpm --filter @stremlist/backend lint
```

See [Stremio detailed execution](stremio.md), [before](stremio-before.png), and
[after](stremio-after.png). Native Nuvio screenshots and accessibility states
were captured in the task conversation.

## Re-run the local candidate

After installing workspace dependencies, run:

```sh
node docs/qa/series-metadata/preview.mjs
```

Install `http://127.0.0.1:7401/ur195879360/manifest.json` in a disposable client
profile alongside Cinemeta, put Stremlist first, then open the series from its
watchlist catalog. Compare with the production manifest URL in the same profile
after restarting the client. For browser local-network restrictions, use the
installed Stremio server's HTTP Web UI proxy described in the detailed report.
Stop the bridge with Ctrl+C. The saved bridge's manifest, series refusal, movie
metadata and nine-series watchlist were independently checked on port 7403.

The existing automated E2E suite resets its database. Do not point that suite
at production; this bridge intentionally uses only public addon GET endpoints.
