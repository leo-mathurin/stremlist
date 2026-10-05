# User-journey coverage

The current inventory contains 41 tester-army browser tests and 70 Playwright
integration tests. This inventory maps supported routes and domain actions to
tests. It is not a claim that every possible input or external-service condition
is covered. CI remains strict, read-only and credential-free for AI replay.

The toolkit uses `e2e@0.17.0`, `@e2e-dev/web@0.12.0`, and the ChatGPT subscription
model `gpt-6-luna`. Eleven tests contain thirteen bounded AI goals. Exact locator
and payload assertions decide whether each recording is accepted. The remaining
thirty toolkit tests use deterministic actions for timing and error boundaries.

## Coverage matrix

Paths in the toolkit column are relative to `toolkit/`; integration paths are
relative to `tests/`. Existing integration coverage is listed so that another
mocked browser test is not mistaken for a missing feature.

| Route or user action                             | Toolkit checks                                                                                                                                                                                               | Real handler/storage/client checks                                                                                                                                                                                                                   | Remaining external limit                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/`, `/terms`, `/changelog`, unknown URL         | `ui.e2e.ts`: headings, return-home navigation                                                                                                                                                                | `home-onboarding.spec.ts`: unknown-route recovery                                                                                                                                                                                                    | External support/donation destinations are links, not payment tests                                              |
| New installation from ID, profile URL or handle  | `ui.e2e.ts`: format/clear, canonical URL, installation links, private/unknown/offline, typed/query configuration failure                                                                                     | `home-onboarding.spec.ts`, `addon-api.spec.ts`: live validation, default manifest bootstrap                                                                                                                                                          | IMDb can change public fixtures                                                                                  |
| Returning user and account change                | `account-newsletter.e2e.ts`: return home, select another account, discard old draft and load new filters                                                                                                     | `home-onboarding.spec.ts`: existing user; `configure-page.spec.ts`: configuration entry                                                                                                                                                              | No account login exists in this app                                                                              |
| `/configure` entry and loading                   | `configuration-recovery.e2e.ts`: invalid/private/unknown/offline then canonical profile recovery; `ui.e2e.ts`: missing user/load retry                                                                       | `configure-page.spec.ts`: real load and failed-load retry                                                                                                                                                                                            | None for the local workflow                                                                                      |
| Catalog add/edit/remove and source normalization | `ui.e2e.ts`: duplicate IDs, last-row protection, ten-row limit; `configuration-recovery.e2e.ts`: invalid source repair, pasted list URL, canonical handle response, canonical duplicate rejection and repair | `configure-page.spec.ts`: list/chart add/remove; `configuration-transitions.spec.ts`: saved removal/reload, retired URL empty, title 31 rejection and 30-character retry                                                                             | Handle normalization uses a fixture for canonical collision; ordinary handles also have live validation coverage |
| Built-in charts and content type                 | `ui.e2e.ts`: add chart, duplicate menu item and limit                                                                                                                                                        | `configuration-transitions.spec.ts`: movie-to-TV source change keeps row ID, persists series mode, updates manifest and reloads; `addon-api.spec.ts`: content modes                                                                                  | Live chart contents are structural assertions, not fixed rankings                                                |
| Catalog order and titles                         | `ui.e2e.ts`: pointer reorder, exact saved positions                                                                                                                                                          | `configuration-transitions.spec.ts`: default titles renumber after reorder, survive reload, manifest order matches                                                                                                                                   | None for local persistence                                                                                       |
| Sort/filter/search                               | `ui.e2e.ts`: genre/preset save/clear; `configuration-recovery.e2e.ts`: saved genre absent from available choices can be cleared                                                                              | `catalog-features.spec.ts`: combined filters/reload/clear, accented and URL-sensitive search, stable shuffle pagination; `addon-api.spec.ts`: all sort options; `configuration-transitions.spec.ts`: empty results recover after removing one filter | Hosted Stremio UI can change                                                                                     |
| Extra preset catalogs                            | `ui.e2e.ts`: enable and preserve preset when clearing filters                                                                                                                                                | `catalog-features.spec.ts`: all three presets in Stremio after reinstall; `configuration-transitions.spec.ts`: disable all, preserve genre, remove manifest entries and retire old preset URLs                                                       | None for local protocol behavior                                                                                 |
| Save errors and concurrent edits                 | `ui.e2e.ts`, `save-refresh.e2e.ts`: HTTP retry, in-flight add/edit/remove/reorder, metadata-only refresh vs real edit; `configuration-recovery.e2e.ts`: network retry and canonical save baseline            | `configuration-transitions.spec.ts`: invalid title does not mutate storage; corrected title persists                                                                                                                                                 | Browser teardown before an acknowledged save is not a durability guarantee                                       |
| Manual refresh                                   | `ui.e2e.ts`: partial failure/success; `refresh-recovery.e2e.ts`: HTTP/network recovery preserves draft, server throttle, cooldown expiry then next refresh                                                   | `configure-page.spec.ts`, `addon-api.spec.ts`: real refresh and server throttling                                                                                                                                                                    | IMDb outage classification remains limited, see below                                                            |
| RPDB                                             | `ui.e2e.ts`: show/hide; concurrent save retains edited key                                                                                                                                                   | `configure-page.spec.ts`: save/clear; `addon-api.spec.ts`: rewritten poster URLs                                                                                                                                                                     | No valid sandbox key is available to prove authenticated poster delivery                                         |
| Installation and clipboard                       | `ui.e2e.ts`: web/desktop URLs and copy denial                                                                                                                                                                | `configure-page.spec.ts`: real clipboard success and denial; `stremio-install.spec.ts`: install/uninstall hosted Stremio                                                                                                                             | OS handling of the `stremio://` protocol is not automated                                                        |
| Stremio Discover, Board, details and metadata    | Frontend only supplies installation links                                                                                                                                                                    | `stremio-catalogs.spec.ts`, `stremio-meta.spec.ts`, `catalog-features.spec.ts`: navigation, filters, cards, movie metadata and series delegation                                                                                                     | Hosted client and live IMDb require network                                                                      |
| Newsletter                                       | `ui.e2e.ts`: email validation, success, rejection/offline; `account-newsletter.e2e.ts`: pending submit lock, error retry, already-subscribed confirmation and input reset                                    | `provider-contract.spec.ts`: actual Resend SDK and HTTP handler, success/duplicate/422/401/503/network outcomes, browser error-to-success recovery                                                                                                   | Provider transport is isolated; no real contact is enrolled and no mail delivery is claimed                      |
| IMDb private list                                | UI catalog source validation is format-based                                                                                                                                                                 | `provider-contract.spec.ts`: actual GraphQL request and list classifier for public/private/FORBIDDEN/missing lists; `addon-api.spec.ts`: live private watchlist and handle                                                                           | Live private `ls` fixture is absent; provide `E2E_PRIVATE_IMDB_LIST_ID` to include it                            |
| Addon cache and unavailable content              | Not duplicated with browser API mocks                                                                                                                                                                        | `addon-api.spec.ts`: R2 generations/tombstone, unavailable cards, malformed catalogs; seeded transitions check removed URLs                                                                                                                          | Production CDN behavior is not simulated                                                                         |

The operational `/monitor` endpoint and actual donation/payment flows are not
user journeys implemented by this application. They are outside this matrix.

## Run and record

From the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd apps/e2e e2e login openai --device
bun run --cwd apps/e2e e2e models openai
bun run test:toolkit:record
bun run test:toolkit:replay
```

Login is a one-time local setup for the existing ChatGPT subscription. No OpenAI
API key is needed. On this workstation, `e2e-chatgpt-session bun run
test:toolkit:record` can use the existing subscription session without copying
credentials into the repository. The model-call limit is twelve per step,
maximum eighteen actions; test deadline is 180 seconds and retries are zero.
Individual goals use smaller call limits.

The toolkit starts Vite on `127.0.0.1:4311` and intercepts API requests to
`127.0.0.1:4314`. It does not need a listener on 4314 or a database. Its intercepted
responses prove UI state and requests, not backend durability.

The replay script sets `CI=1 E2E_OAUTH_CREDENTIALS='{}'` and `--strict-cache`.
CI calls that unchanged script. It cannot load local OAuth credentials, call a
model, record a new entry, retry or skip an AI test. Missing/stale recordings fail.
Commit only assertion-verified `.e2e/cache/*.json` files; do not edit them by hand.
Reports, screenshots and traces remain ignored under `.e2e/`.

## Real backend and provider boundaries

The Playwright harness starts the normal backend and frontend on 7301/7302. Local
storage tests use a disposable Supabase database and RustFS 1.0.1 S3 store. Seeded
IMDb metadata is input data; configuration, manifests, catalog filtering and
storage updates execute the actual backend. Existing live projects also call
IMDb and hosted Stremio.

`provider-contract.spec.ts` starts a separate backend on an OS-assigned loopback
port with explicit dummy environment values and a test-only preload. It uses the
actual Resend SDK, GraphQL serialization/parsing, validation and route handlers.
Only the outbound provider transport is replaced. The fixture verifies request
method, audience path, synthetic email domain and subscription state. It never
falls back to native fetch. All unknown destinations are rejected, so it cannot
create real contacts or send mail. The process is closed after tests, with a
bounded SIGTERM/SIGKILL fallback. No production test hook or CI credentials were
added.

A dedicated local stack avoids the existing development database. See
[README.md](README.md) for the standard setup. The latest local verification used
`/tmp/stremlist-e2e-20261006`, project ID `stremlist-agent-e2e-20261006`, Supabase
553xx ports and container `stremlist-agent-e2e-r2-20261006` on port 7531:

```sh
E2E_SUPABASE_URL=http://127.0.0.1:55321 \
E2E_R2_ENDPOINT=http://127.0.0.1:7531 \
bun run --cwd apps/e2e test:e2e
```

Cleanup must target only that test stack:

```sh
supabase stop --workdir /tmp/stremlist-e2e-20261006 --no-backup
docker stop stremlist-agent-e2e-r2-20261006
```

## Current verification and defects found

On 2026-10-06, the four new AI goals used thirteen real model calls and 69,735
model tokens. The existing nine goals replayed in that recording run. The full
expanded strict run passed all 41 toolkit tests, replayed thirteen recordings,
and used zero model calls/tokens, retries and skips. The run with no new cache
entries first failed all four new goals without authenticating or skipping.
Reports are local: `.e2e/expanded-cold/`, `.e2e/expanded-replay/`,
`.e2e/missing-new/`.

The complete Playwright run passed all 70 tests (local, live smoke and live
regression) with the isolated Supabase/RustFS stack. This includes all seventeen
new storage and provider checks. No retry or skip was used. Backend tests passed
189/189. Backend, frontend and E2E typechecks and relevant lint/format checks
passed. The thirteen cache files parse as JSON and contain no credential patterns.

The preset-removal test uses keyboard activation and awaits each checked-state
change. This avoids Playwright's immediate post-click `uncheck()` check on the
animated Radix control, which flaked once in the first Linux run. The revised
test passed five consecutive local runs with retries disabled.

The provider tests reproduced Resend's returned-error behavior: the old handler
reported successful subscription for duplicate, invalid-email, unauthorized,
unavailable and network outcomes. It now sends those returned errors through the
existing error mapping. The browser regression verifies that a failed submission
retains the email and that a later success resets it. The title-boundary test also
found that schema errors rendered as `[object Object]`. Configuration validation
now returns the same string error contract as other config failures.

Earlier regressions on this PR fixed failed lookup being treated as an existing
account, reinstall baselines after new row IDs, edits lost during saves, and
refresh metadata causing false unsaved changes. Their tests remain in the current
inventory. The branch includes staging's Bun migration and RustFS infrastructure;
legacy MinIO instructions and intermediate test counts have been removed here.

## Known limits

- IMDb validation currently classifies some upstream HTTP/network failures as
  `not_found`. This is inherited in the scraper and its unit contracts. The new
  provider tests do not assert that this diagnostic is correct. Separating
  transient service errors from missing IDs remains a known product gap.
- The private-list provider fixture proves protocol classification, not live
  access to a private IMDb list. A stable owner-controlled list is needed for
  that live check.
- RPDB URL rewriting is covered; authenticated poster delivery needs a valid
  sandbox key. Newsletter integration is isolated at the provider transport;
  real audience enrollment, broadcast and inbox delivery are not performed.
- Desktop protocol handling and external support/payment destinations need
  platform or provider-specific QA. No real purchase or subscription is made.
