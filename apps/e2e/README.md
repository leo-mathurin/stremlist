# @stremlist/e2e

End-to-end tests that exercise Stremlist the way a real user does: the addon
is installed into the **hosted Stremio Web app** (web.stremio.com) from a
backend running locally, with **live IMDb data** or controlled catalog fixtures, a **local Supabase stack**,
and a **local MinIO bucket** exercising the same S3 API used for Cloudflare
R2. The configure/onboarding pages of the frontend are covered too.

## How it works

- Playwright starts the backend (`:7301`) and the frontend (`:7302`) as web
  servers with ports distinct from the dev ones, so tests can run next to a
  normal dev session.
- The backend points at a local Supabase stack (`supabase start`), reset
  between tests. Live scenarios bootstrap through the backend HTTP API. The
  deterministic catalog scenarios seed input rows and cache objects directly,
  then exercise the real configuration API, database transaction and cache reader.
- The backend points at MinIO (`:7431`) through its configurable S3 endpoint.
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
  local coverage, four live smoke tests, and the broader live regression suite.

## Running locally

```sh
# One-time / per boot: start the local Supabase stack (needs Docker running)
supabase start -x gotrue,realtime,storage-api,imgproxy,studio,edge-runtime,logflare,vector,supavisor,mailpit,postgres-meta

docker run --rm -d --name stremlist-e2e-r2 \
  -p 127.0.0.1:7431:9000 \
  -e MINIO_ROOT_USER=stremlist-e2e \
  -e MINIO_ROOT_PASSWORD=stremlist-e2e-secret \
  quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z server /data

# From the repo root: run every E2E project
pnpm test:e2e

# Select one project while debugging
pnpm --filter @stremlist/e2e test:e2e --project=local
pnpm --filter @stremlist/e2e test:e2e --project=live-smoke
pnpm --filter @stremlist/e2e test:e2e --project=live-regression
```

The suite deletes test users between cases. It removes their R2 objects first,
then relies on foreign-key cascades for their Supabase watchlists. The harness
rejects any non-loopback Supabase URL unless the caller provides the explicit
destructive confirmation described below.

## Catalog feature regression scenarios

`tests/catalog-features.spec.ts` covers the v1.10.0 additions with controlled
movie/series metadata in local storage. No configuration or catalog HTTP response
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
pnpm --filter @stremlist/e2e test:e2e tests/catalog-features.spec.ts
```

These fixtures bypass IMDb scraping, not Stremlist behavior. Existing live tests
still cover real IMDb fetching. The series scenario checks the addon protocol;
it does not claim to test playback or episode selection in a native client.

## Environment knobs

| Variable                                                 | Purpose                                                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `E2E_SUPABASE_URL` / `E2E_SUPABASE_SERVICE_ROLE_KEY`     | Non-default local Supabase stack                                                          |
| `E2E_R2_ENDPOINT` / `E2E_R2_BUCKET`                      | Non-default S3-compatible endpoint and disposable bucket                                  |
| `E2E_R2_ACCESS_KEY_ID` / `E2E_R2_SECRET_ACCESS_KEY`      | Credentials for the disposable S3-compatible store                                        |
| `E2E_ALLOW_REMOTE_DATABASE=I_UNDERSTAND_THIS_WIPES_DATA` | Permit an isolated remote test project. Cleanup deletes every user and all dependent data |
| `E2E_IMDB_USER_ID` / `E2E_IMDB_USER_ID_2`                | Override the public watchlists under test                                                 |
| `E2E_IMDB_LIST_ID`                                       | Override the public `ls` list under test                                                  |
| `E2E_PRIVATE_IMDB_USER_ID`                               | Override the private watchlist under test                                                 |
| `E2E_PRIVATE_IMDB_LIST_ID`                               | Enable the private `ls` list test                                                         |

## Known limitations

- Drag-and-drop catalog reordering (pointer-based dnd-kit) is not covered.
- The newsletter endpoint is not covered (it would email real people).
- The live smoke and regression suites depend on web.stremio.com and IMDb. CI
  retries failures twice.
