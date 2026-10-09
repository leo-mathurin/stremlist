# @stremlist/e2e

The tester-army toolkit uses the existing ChatGPT subscription to record AI
browser journeys, then replays committed actions without credentials in CI.
Application API responses are intercepted. Run `bun run test:toolkit` from the
repository root. See [TOOLKIT.md](./TOOLKIT.md) for setup, coverage, reports,
and isolated integration verification.

End-to-end tests that exercise Stremlist the way a real user does: the addon
is installed into the **hosted Stremio Web app** (web.stremio.com) from a
backend running locally, with **live IMDb data** or controlled catalog fixtures, a **local Supabase stack**,
and a **local RustFS bucket** exercising the same S3 API used for Cloudflare
R2. The configure/onboarding pages of the frontend are covered too.

## How it works

- Playwright starts the backend (`:7301`) and the frontend (`:7302`) as web
  servers with ports distinct from the dev ones, so tests can run next to a
  normal dev session.
- The backend points at a local Supabase stack (`supabase start`), reset
  between tests. Tests use the vocabulary of [CONTEXT.md](../../CONTEXT.md):
  most scenarios seed a private **Account** (generated `sl_…` ID) with its
  **Lists** directly, so no save-triggered prewarm reads a Provider, then
  exercise the real configuration API, database transaction and cache reader.
  The onboarding scenarios create the Account through the configure page
  (`POST /accounts`), and the Legacy alias scenarios bootstrap an `ur…`
  install through its first manifest fetch.
- The backend points at RustFS (`:7431`) through its configurable S3 endpoint.
  Tests inspect the resulting manifest and compressed generation objects and
  remove objects owned by E2E users between cases.
- Stremio Web runs in anonymous mode: each fresh browser context has its own
  local addon collection. No Stremio account or shared state is involved.
- Chromium is launched with `--disable-features=LocalNetworkAccessChecks,...`
  because Chrome otherwise blocks the HTTPS Stremio Web page from fetching the
  addon on `127.0.0.1` (Local Network Access permission, never grantable in
  headless runs).
- Live IMDb assertions are structural (ordering invariants, id shapes,
  counts) or compare the Stremio UI against the addon's own catalog JSON from
  the same run, so they do not depend on what is in the watchlist today.
- The default run and pull request CI execute all three projects: deterministic
  local coverage (67 tests), four live smoke tests, and the broader live
  regression suite (26 tests).
- The backend gets a fixed, public `CONNECTION_ENCRYPTION_KEY` from `env.ts`,
  so seeded Connections (`helpers/db.ts` `seedConnection`) decrypt like real
  ones. It is not a production key.

## Running locally

```sh
# One-time / per boot: start the local Supabase stack (needs Docker running)
supabase start -x gotrue,realtime,storage-api,imgproxy,studio,edge-runtime,logflare,vector,supavisor,mailpit,postgres-meta

docker run --rm -d --name stremlist-e2e-r2 \
  -p 127.0.0.1:7431:9000 \
  -e RUSTFS_ACCESS_KEY=stremlist-e2e \
  -e RUSTFS_SECRET_KEY=stremlist-e2e-secret \
  rustfs/rustfs:1.0.1 /data

# From the repo root: run every E2E project
bun run test:e2e

# Select one project while debugging
bun run --filter @stremlist/e2e test:e2e --project=local
bun run --filter @stremlist/e2e test:e2e --project=live-smoke
bun run --filter @stremlist/e2e test:e2e --project=live-regression
```

The suite deletes test Accounts between cases: the Legacy alias Accounts of the
fixtures and every Account created since the run started. It removes their R2
List caches and Connection objects first, then relies on foreign-key cascades
for their Lists, Connections and pending authorizations. Because Account IDs
are generated, cleanup is scoped by time, so use a disposable stack, not a
development database that other people write to at the same time. The harness
rejects any non-loopback Supabase URL unless the caller provides the explicit
destructive confirmation described below.

## Catalog feature regression scenarios

`tests/catalog-features.spec.ts` covers the v1.10.0 additions with controlled
movie/series metadata in local storage, read through a seeded private Account. No configuration or catalog HTTP response
is mocked. The small fixture deliberately includes titles just outside each
filter so a missing constraint fails the test.

| Project           | Coverage                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `local`           | Combined genre/decade/runtime/rating filters saved through Configure, reload persistence, clearing filters while keeping presets |
| `local`           | Search with accents and literal `&`/`+`, combined with saved filters and empty results                                           |
| `local`           | Stable shuffle pagination over 215 titles, with no duplicates or missing items                                                   |
| `local`           | Series catalog preserved, movie-only metadata advertisement and null series metadata fallback                                    |
| `live-regression` | Filtered results and all four new runtime/release-date sorts in the real Stremio dropdown                                        |
| `live-regression` | Enable all three presets in Configure, reinstall in Stremio, verify home rows and catalog contents                               |
| `live-regression` | Enter searches in Stremio and verify both the actual backend response and rendered results                                       |

Run just these scenarios (the same file is included automatically in PR CI):

```sh
bun run --filter @stremlist/e2e test:e2e tests/catalog-features.spec.ts
```

These fixtures bypass IMDb scraping, not Stremlist behavior. Existing live tests
still cover real IMDb fetching. The series scenario checks the addon protocol;
it does not claim to test playback or episode selection in a native client.

## Provider journeys

`tests/provider-journeys.spec.ts` (`local`) starts a second backend with
`helpers/provider-fixtures.ts` as a preload. That backend uses the same local
Supabase and RustFS stack, dummy OAuth client IDs and no real credential. The
real adapters, OAuth flow, ID resolver and Action pages run; only the Provider
responses are fixtures, and any request to an unknown host fails. It covers
public links (Trakt, JustWatch, SensCritique), Source lists read through a
Connection (MDBList, Simkl, Trakt), OAuth start and callback (Trakt, Simkl,
MDBList), disconnect, expired Connections, Legacy alias limits, every Trakt
Action intent and its page, the Provider kill switch (a third backend
with `DISABLED_PROVIDERS`), and Catalog previews read through a Connection. Letterboxd has no adapter yet; the configure page
only explains its MDBList import. The UI side of the same journeys is in `toolkit/providers.e2e.ts`.
`tests/catalog-preview.spec.ts` uses the same preload to read a synthetic
SensCritique list (`helpers/preview-fixture.ts`) for the Catalog preview.

## List sync status scenarios

`tests/sync-status.spec.ts` checks what each refresh records (STR-58). The test
backend has no Trakt client ID, so Trakt reads fail and a seeded expired Trakt
Connection becomes a refused one (`needs_renewal_since`), offline and
deterministic. The `live-regression` case waits for the first refresh of a live
IMDb chart through the page's polling. The renewal by a new authorization, a
working read that clears the mark and the statuses a disconnect forgets need
the Provider fixtures, so they are in `tests/provider-journeys.spec.ts`.

## Environment knobs

| Variable                                                 | Purpose                                                                                 |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `E2E_SUPABASE_URL` / `E2E_SUPABASE_SERVICE_ROLE_KEY`     | Non-default local Supabase stack                                                        |
| `E2E_R2_ENDPOINT` / `E2E_R2_BUCKET`                      | Non-default S3-compatible endpoint and disposable bucket                                |
| `E2E_R2_ACCESS_KEY_ID` / `E2E_R2_SECRET_ACCESS_KEY`      | Credentials for the disposable S3-compatible store                                      |
| `E2E_ALLOW_REMOTE_DATABASE=I_UNDERSTAND_THIS_WIPES_DATA` | Permit an isolated remote test project. Cleanup deletes Accounts and all dependent data |
| `E2E_IMDB_USER_ID` / `E2E_IMDB_USER_ID_2`                | Override the public IMDb watchlists under test (also the Legacy aliases)                |
| `E2E_IMDB_LIST_ID`                                       | Override the public `ls` list under test                                                |
| `E2E_PRIVATE_IMDB_USER_ID`                               | Override the private watchlist under test                                               |
| `E2E_PRIVATE_IMDB_LIST_ID`                               | Enable the private `ls` list test                                                       |

## Known limitations

- Pointer-based catalog reordering is covered by the toolkit, including saved positions.
- Newsletter UI states use intercepted toolkit responses. Real delivery is not tested.
- The live smoke and regression suites depend on web.stremio.com and IMDb. CI
  retries failures twice.
