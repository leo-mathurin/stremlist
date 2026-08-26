# @stremlist/e2e

End-to-end tests that exercise Stremlist the way a real user does: the addon
is installed into the **hosted Stremio Web app** (web.stremio.com) from a
backend running locally, with **live IMDb data** and a **local Supabase
stack**. The configure/onboarding pages of the frontend are covered too.

## How it works

- Playwright starts the backend (`:7301`) and the frontend (`:7302`) as web
  servers with ports distinct from the dev ones, so tests can run next to a
  normal dev session.
- The backend points at a local Supabase stack (`supabase start`), reset
  between tests. Functional seeding goes through the backend's own HTTP API,
  so tests exercise real code paths.
- Stremio Web runs in anonymous mode: each fresh browser context has its own
  local addon collection. No Stremio account or shared state is involved.
- Chromium is launched with `--disable-features=LocalNetworkAccessChecks,...`
  because Chrome otherwise blocks the HTTPS Stremio Web page from fetching the
  addon on `127.0.0.1` (Local Network Access permission, never grantable in
  headless runs).
- IMDb is live. Assertions are structural (ordering invariants, id shapes,
  counts) or compare the Stremio UI against the addon's own catalog JSON from
  the same run, so they do not depend on what is in the watchlist today.
- The default run contains deterministic local coverage plus four live smoke
  tests. Broader live checks stay in the `live-regression` project and run only
  when requested.

## Running locally

```sh
# One-time / per boot: start the local Supabase stack (needs Docker running)
supabase start -x gotrue,realtime,storage-api,imgproxy,studio,edge-runtime,logflare,vector,supavisor,mailpit,postgres-meta

# From the repo root: local coverage plus the small live smoke suite
pnpm test:e2e

# Or from this package, with more options
pnpm --filter @stremlist/e2e test:e2e:local       # deterministic local suite
pnpm --filter @stremlist/e2e test:e2e:live        # four live smoke tests
pnpm --filter @stremlist/e2e test:e2e:live:full   # all live external checks
pnpm --filter @stremlist/e2e test:e2e:all         # every project
pnpm --filter @stremlist/e2e test:e2e:headed      # smoke tests with a browser
pnpm --filter @stremlist/e2e report               # open the last HTML report
```

The suite deletes test users between cases. Foreign-key cascades clear their
watchlists and caches in the same database statement. The harness rejects any
non-loopback Supabase URL unless the caller provides the explicit destructive
confirmation described below.

## Environment knobs

| Variable                                                 | Purpose                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `E2E_SUPABASE_URL` / `E2E_SUPABASE_SERVICE_ROLE_KEY`     | Non-default local Supabase stack                                                                        |
| `E2E_ALLOW_REMOTE_DATABASE=I_UNDERSTAND_THIS_WIPES_DATA` | Permit an isolated remote test project. Cleanup deletes every user and all dependent data               |
| `E2E_IMDB_USER_ID` / `E2E_IMDB_USER_ID_2`                | Override the public watchlists under test                                                               |
| `E2E_IMDB_LIST_ID`                                       | Override the public `ls` list under test                                                                |
| `E2E_PRIVATE_IMDB_USER_ID`                               | Override the private watchlist under test (default: a maintainer-owned account kept private on purpose) |
| `E2E_PRIVATE_IMDB_LIST_ID`                               | Enable the private `ls` list test (skipped otherwise — no stable private list id is available)          |

## Known limitations

- Drag-and-drop catalog reordering (pointer-based dnd-kit) is not covered.
- The newsletter endpoint is not covered (it would email real people).
- The live smoke and full regression suites depend on web.stremio.com and IMDb.
  CI runs only the four smoke checks and retries them twice on failure.
