# User-journey coverage

The current inventory contains 65 tester-army browser tests and 90 Playwright
integration tests (60 `local`, 4 `live-smoke`, 26 `live-regression`). This
inventory maps supported routes and domain actions to tests. It is not a claim
that every possible input or external-service condition is covered. CI remains
strict, read-only and credential-free for AI replay.

The words follow [CONTEXT.md](../../CONTEXT.md): an **Account** has an Addon
URL with a generated Account ID (`sl_…`), or a **Legacy alias** (`ur…`) for
installs made before Accounts. An Account configures **Lists**; each List
points to one **Source list** on a **Provider** and produces **Catalogs**.

The toolkit uses `e2e@0.17.0`, `@e2e-dev/web@0.12.0` (exact versions in
`package.json`, see "Cache rules"), and the ChatGPT subscription model
`gpt-6-luna`. Fifteen tests contain seventeen bounded AI goals. Exact locator
and payload assertions decide whether each recording is accepted. The remaining
fifty toolkit tests use deterministic actions for timing, error
boundaries and page content.

## Coverage matrix

Paths in the toolkit column are relative to `toolkit/`; integration paths are
relative to `tests/`. Existing integration coverage is listed so that another
mocked browser test is not mistaken for a missing feature.

| Route or user action                                            | Toolkit checks                                                                                                                                                                                                                                                                                               | Real handler/storage/client checks                                                                                                                                                                                                                                                                                                                                                              | Remaining external limit                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `/`, `/terms`, `/changelog`, unknown URL                        | `ui.e2e.ts`: headings, return-home navigation; `home.e2e.ts`: Terms and Changelog section links ("On this page"), site links, "Back to Home"                                                                                                                                                                 | `home-onboarding.spec.ts`: unknown-route recovery                                                                                                                                                                                                                                                                                                                                               | External support/donation destinations are links, not payment tests                         |
| Home sections (redesign)                                        | `home.e2e.ts`: Providers diagram (every Provider, Letterboxd "Soon"), section headings, live count (plural, singular, hidden at 0 or on error), Troubleshooting accordion, Addon Manager and terms links                                                                                                     | `addon-api.spec.ts`: `/stats` counts active Accounts                                                                                                                                                                                                                                                                                                                                            | The Stremio preview and the beams are decoration; posters load from an external CDN         |
| New setup from a pasted link (Home or Configure)                | `ui.e2e.ts`: Provider detection hints (Letterboxd: coming soon), Addon URL detection, empty hint after reset; `home.e2e.ts`: "Build my Stremlist" opens an empty setup; profile URL to canonical `ur…` and first save to Account ID install links; private/unknown/offline link refusals                     | `home-onboarding.spec.ts`: live link, first save creates the Account, install links; unknown and unrecognized links; `addon-api.spec.ts`: `/links/resolve` for public, private, unknown, `p.` handle, chart, unrecognized and MDBList needs-Connection; new Account creation                                                                                                                    | IMDb can change public fixtures                                                             |
| Returning install and switching Account                         | `ui.e2e.ts`: open by Addon URL ("Open it"), old `?userId=` link to the Legacy alias view; `home.e2e.ts`: "Open it" refuses other text, an Addon URL pasted in the main field opens its install; `account-newsletter.e2e.ts`: go home, open another Addon URL, discard the old draft and load the new filters | `configure-page.spec.ts`: Addon URL (`stremio://`) in "Open it" for an Account and a Legacy alias; `home-onboarding.spec.ts`: `?userId=` redirect                                                                                                                                                                                                                                               | No account login exists in this app; the Addon URL is the credential (ADR 0001)             |
| `/configure` entry and loading                                  | `configuration-recovery.e2e.ts`: invalid/private/unknown/offline link, then canonical profile and first save; `ui.e2e.ts`: missing Account, load retry, failed lookup never becomes a new setup                                                                                                              | `configure-page.spec.ts`: real load, failed-load retry, unknown Account ID and Legacy alias                                                                                                                                                                                                                                                                                                     | None for the local workflow                                                                 |
| List add/edit/remove and link normalization                     | `ui.e2e.ts`: duplicate link refused, title edit, removing every List disables Save, ten-List limit; `configuration-recovery.e2e.ts`: unrecognized link, pasted list URL, canonical duplicate refusal and repair                                                                                              | `configure-page.spec.ts`: live list link and chart add/remove, first List of an Account saved without Lists asks for a reinstall; `configuration-transitions.spec.ts`: saved removal/reload, retired URL empty, 61-character title refused by the API and capped by the field                                                                                                                   | Handle normalization uses a fixture for the canonical collision                             |
| Built-in charts and content type                                | `ui.e2e.ts`: add chart, disabled duplicate menu item, IMDb and Trakt charts up to the limit                                                                                                                                                                                                                  | `configuration-transitions.spec.ts`: movie-to-TV chart change keeps List ID, persists series mode, updates manifest and reloads; `addon-api.spec.ts`: content modes                                                                                                                                                                                                                             | Live chart contents are structural assertions, not fixed rankings                           |
| List order and titles                                           | `ui.e2e.ts`: pointer reorder, exact saved positions                                                                                                                                                                                                                                                          | `configuration-transitions.spec.ts`: default titles renumber after reorder, survive reload, manifest order matches                                                                                                                                                                                                                                                                              | None for local persistence                                                                  |
| Sort/filter/search                                              | `ui.e2e.ts`: genre/preset save/clear; `configuration-recovery.e2e.ts`: saved genre absent from available choices can be cleared                                                                                                                                                                              | `catalog-features.spec.ts`: combined filters/reload/clear, accented and URL-sensitive search, stable shuffle pagination; `addon-api.spec.ts`: all sort options; `configuration-transitions.spec.ts`: empty results recover after removing one filter                                                                                                                                            | Hosted Stremio UI can change                                                                |
| Extra preset catalogs                                           | `ui.e2e.ts`: enable and preserve preset when clearing filters                                                                                                                                                                                                                                                | `catalog-features.spec.ts`: all three presets in Stremio after reinstall; `configuration-transitions.spec.ts`: disable all, preserve genre, remove manifest entries and retire old preset URLs                                                                                                                                                                                                  | None for local protocol behavior                                                            |
| Save errors and concurrent edits                                | `ui.e2e.ts`, `save-refresh.e2e.ts`: HTTP retry, in-flight add/edit/remove/reorder, metadata-only refresh vs real edit; `configuration-recovery.e2e.ts`: network retry and normalized-source save baseline                                                                                                    | `configuration-transitions.spec.ts`: invalid title does not mutate storage; corrected title persists; `addon-api.spec.ts`: invalid configurations, including a Source list that needs a missing Connection, keep storage                                                                                                                                                                        | Browser teardown before an acknowledged save is not a durability guarantee                  |
| Manual refresh                                                  | `ui.e2e.ts`: partial failure/success; `refresh-recovery.e2e.ts`: HTTP/network recovery preserves draft, server throttle, cooldown expiry then next refresh                                                                                                                                                   | `configure-page.spec.ts`, `addon-api.spec.ts`: real refresh and server throttling                                                                                                                                                                                                                                                                                                               | IMDb outage classification remains limited, see below                                       |
| List sync status and Connection renewal                         | `sync-status.e2e.ts`: synced and failing rows, attention count, polling until a first refresh, manual refresh, refused or missing Connection (AI goal: renew from the List), recovery after a new Connection                                                                                                 | `sync-status.spec.ts`: a failed refresh keeps the last success; a refused Connection gets `needs_renewal_since` and public Trakt Lists do not fail with it; Legacy alias `/sync-status`; status from the cache; live IMDb chart first refresh by polling                                                                                                                                        | Real Trakt OAuth is not run in this spec: its backend has no Trakt client ID                |
| RPDB                                                            | `ui.e2e.ts`: show/hide                                                                                                                                                                                                                                                                                       | `configure-page.spec.ts`: save/clear; `addon-api.spec.ts`: rewritten poster URLs, key on Account creation                                                                                                                                                                                                                                                                                       | No valid sandbox key is available to prove authenticated poster delivery                    |
| Installation and clipboard                                      | `ui.e2e.ts`: Stremio and Stremio Web install links of a new Account, Addon URL copy denial                                                                                                                                                                                                                   | `configure-page.spec.ts`: real clipboard success and denial; `stremio-install.spec.ts`: install/uninstall hosted Stremio with an Account ID and with a Legacy alias                                                                                                                                                                                                                             | OS handling of the `stremio://` protocol is not automated                                   |
| Legacy alias installs                                           | `ui.e2e.ts`: old `?userId=` link, upgrade card, Actions locked; `providers.e2e.ts`: Connect points to the upgrade, upgrade to a private Addon URL and open it, a moved install cannot be changed                                                                                                             | `addon-api.spec.ts`: first manifest creates the legacy Account and its watchlist List, historic manifest ID; private Addon URL manifest hides the Account ID; configure redirect for both keys; `provider-journeys.spec.ts`: no private List, Connection or Action through the alias, upgrade copies Lists without the Connection, moved install refuses saves                                  | None for local behavior                                                                     |
| Provider links (Trakt, JustWatch, SensCritique, MDBList, Simkl) | `providers.e2e.ts`: link hints, detected Provider, rows and first-save payload for Trakt, JustWatch, SensCritique and IMDb links; Trakt chart from Quick add; a Letterboxd link shows the MDBList import steps without a lookup                                                                              | `provider-journeys.spec.ts`: real adapters resolve public links and refusals (private, not found), Catalogs from fixture data, SensCritique IDs resolved through Wikidata; MDBList list and Simkl plan to watch read through a seeded Connection                                                                                                                                                | Provider APIs are fixtures; their real responses can change                                 |
| Connect a Provider (OAuth)                                      | `providers.e2e.ts`: a link that needs a Connection saves the setup, connects (authorize page intercepted), comes back and adds the link; Connection sources in Quick add; denied/expired/failed returns                                                                                                      | `provider-journeys.spec.ts`: start URL and PKCE challenge, callback token exchange with the verifier, encrypted Connection with username, one-time state, denied and invalid callbacks, Connection sources, private `me/` List served with the new token; Simkl and MDBList start and callback store their Connection                                                                           | No real Provider login; authorize pages are not loaded                                      |
| Disconnect, expired Connection, private Lists                   | `providers.e2e.ts`: confirm and cancel, disconnect, "Connect again" card, Actions cleared on save, Connect again starts OAuth                                                                                                                                                                                | `provider-journeys.spec.ts`: revoke request, Connection row and cached Catalog removed, needs-Connection card; expired token refreshed with the stored redirect URI, or card when the refresh is refused                                                                                                                                                                                        | None for local behavior                                                                     |
| Actions from Stremio                                            | `providers.e2e.ts`: Actions toggle, Provider order and choice saved, reinstall message                                                                                                                                                                                                                       | `provider-journeys.spec.ts`: `stream` resource in the manifest, Action entry URL, Action page performs the Trakt watchlist write; no entries through a Legacy alias or after disconnect; every Trakt intent (watchlist add/remove, episode watched/unwatched, rating form, rate and remove) sends its write and updates the entries; unknown intents and Accounts get "This link does not work" | Stremio's own stream list UI is not driven; Simkl and MDBList writes are unit-tested only   |
| Provider kill switch (`DISABLED_PROVIDERS`)                     | `providers.e2e.ts`: a Provider that is off shows "Temporarily unavailable", has no Connect button or Quick add charts, and its links are refused                                                                                                                                                             | `provider-journeys.spec.ts`: a backend with Providers off reports them, refuses their links, keeps the cached Catalog, shows the disabled card without a cache, refuses Connect and own lists, gives no Action entries, and sends no Provider request                                                                                                                                           | None for local behavior                                                                     |
| Stremio Discover, Board, details and metadata                   | Frontend only supplies installation links                                                                                                                                                                                                                                                                    | `stremio-catalogs.spec.ts`, `stremio-meta.spec.ts`, `catalog-features.spec.ts`: navigation, filters, cards, movie metadata and series delegation                                                                                                                                                                                                                                                | Hosted client and live IMDb require network                                                 |
| Newsletter                                                      | `ui.e2e.ts`: email validation, success, rejection/offline; `account-newsletter.e2e.ts`: pending submit lock, error retry, already-subscribed confirmation and input reset                                                                                                                                    | `provider-contract.spec.ts`: actual Resend SDK and HTTP handler, success/duplicate/422/401/503/network outcomes, browser error-to-success recovery                                                                                                                                                                                                                                              | Provider transport is isolated; no real contact is enrolled and no mail delivery is claimed |
| IMDb private list                                               | Link refusals use intercepted `/links/resolve` answers                                                                                                                                                                                                                                                       | `provider-contract.spec.ts`: actual GraphQL request and list classifier behind `/links/resolve` for public/private/FORBIDDEN/missing lists; `addon-api.spec.ts`: live private watchlist and handle                                                                                                                                                                                              | Live private `ls` fixture is absent; provide `E2E_PRIVATE_IMDB_LIST_ID` to include it       |
| Addon cache and unavailable content                             | Not duplicated with browser API mocks                                                                                                                                                                                                                                                                        | `addon-api.spec.ts`: R2 generations/tombstone, unavailable cards, malformed catalogs; seeded transitions check removed URLs                                                                                                                                                                                                                                                                     | Production CDN behavior is not simulated                                                    |

The operational `/monitor` endpoint and actual donation/payment flows are not
user journeys implemented by this application. They are outside this matrix.

### Journeys that changed

The multi-Provider branch and the Home redesign replaced some screens. Their
tests keep the same intent with the new flow:

- Home no longer validates an IMDb ID and shows install links at once. A
  pasted link becomes the first List on the configure page, and the first
  save creates the Account and its Addon URL. The old "validation reports"
  and "profile URL" journeys now run through `/links/resolve` and
  `POST /accounts`.
- "Welcome back" for a known IMDb ID no longer exists. A returning user opens
  the configure page from Stremio, pastes the Addon URL on Home ("Open it"),
  or follows an old `?userId=` link, which opens the Legacy alias.
- The redesigned Home (2026-10-08) replaced the "I already have one" button
  with "Already have a Stremlist? Open it", removed the default hint under
  the link field, and changed the headline to "Your lists, all in Stremio.".
  The tests now use "Open it" and the new headline; an empty field must show
  no hint. Nothing else in these journeys changed.
- A List row has no free-text source field. Sources come from a pasted link,
  a Connection or a chart, so the old "invalid source blocks save" journey is
  now "an unrecognized link adds nothing".
- The last List can be removed. Save is then off, so an Account cannot be
  saved without Lists. This replaces the old disabled remove button.

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

`toolkit/config-fixture.ts` holds the shared fixture: a private Account
(`sl_E2eFixtureAccount00001`) with one IMDb watchlist List, its Legacy alias
view, `baseRoutes()` (answers `/providers` and `/stats`, and fails the test on
any other request that no later route takes), `captureConfig()` (records
saves and echoes the saved Lists like the backend), `routeResolve()` for
`/links/resolve`, and the exact save messages. Register `baseRoutes()` first:
routes run newest first.

The replay script sets `CI=1 E2E_OAUTH_CREDENTIALS='{}'` and `--strict-cache`.
CI calls that unchanged script. It cannot load local OAuth credentials, call a
model, record a new entry, retry or skip an AI test. Missing/stale recordings fail.
Commit only assertion-verified `.e2e/cache/*.json` files; do not edit them by hand.
Reports, screenshots and traces remain ignored under `.e2e/`.

### Cache rules

Each AI goal has one cache file. Its key holds the project ID, the test file
path and title, the target, the engine minor version, the goal text and its
`{param}` values, the app URL (`127.0.0.1:4311`) and environment, the agent,
and the replay policy. These edits re-key a recording, so the next run asks
the model again:

- renaming or moving a test file, or renaming a test;
- changing a goal's text or its `params`;
- changing the app URL, its port or `app.identity` (this re-keys every entry
  on every open branch, so do not do it);
- a new `e2e` or `@e2e-dev/web` version. Both are pinned to exact versions;
  bump them only in a change that re-records every entry.

A recording that keeps its key can still go stale: it replays controls by role
and accessible name and checks the start and end routes and some controls
that must be present or absent. Renaming a button, a link or a label that a
recording uses makes it `REPLAY_STALE` under `--strict-cache`.

Write goals with unique accessible names, not positions ("the second button")
or data that changes. Put the re-recorded cache file in the same commit as the
test, goal or UI change that needed it, and delete the files of goals that no
longer exist. To re-record, run `e2e-chatgpt-session bun run --cwd apps/e2e
test:toolkit:record`, run it a second time to prove that it makes zero model
calls, then run `bun run --cwd apps/e2e test:toolkit:replay`.

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

The harness seeds controlled state through `helpers/db.ts` (service-role
client, loopback databases only):

- `seedAccount()` / `seedAccount({ legacyImdbUserId })`: a private Account or
  a Legacy alias Account, with no save-triggered prewarm.
- `seedList(accountId, { provider, sourceRef, … })` and
  `seedAccountWithLists([...])`: List rows for any Provider.
- `seedConnection(accountId, provider, { expiresAt, refreshToken, … })`: a
  Connection with synthetic tokens, encrypted with the public test
  `CONNECTION_ENCRYPTION_KEY` of `env.ts` (the Playwright backend gets the same
  key) and the required `redirect_uri`.
- `helpers/provider-backend.ts` `startProviderBackend(preload, env)`: a
  second backend on a free loopback port with only the given variables.
- `helpers/provider-fixtures.ts`: the preload of `provider-journeys.spec.ts`.
  It answers Trakt, MDBList, Simkl, JustWatch, SensCritique, Wikidata and
  IMDb title requests with fixed data, passes loopback requests (Supabase)
  to the real fetch, refuses every other host and logs each Provider request
  to `E2E_PROVIDER_LOG`. It accepts the tokens `fixture-access-token` (the
  `seedConnection` default) and `fresh-access` (from the code
  `fixture-code`); the refresh token `rejected-refresh` is refused.
- `helpers/catalog-fixture.ts` `seedCatalog()`: a private Account whose List
  reads a synthetic IMDb watchlist cached in RustFS.
- `helpers/api.ts`: `createAccount`, `postConfig`, `resolveLink`, `upgrade`,
  `bootstrapLegacy` (first manifest fetch of a Legacy alias) and the catalog,
  meta and manifest readers.

`resetDb()` deletes the Legacy alias Accounts of the fixtures and every Account
created since the run started (`E2E_RUN_STARTED_AT`), after it removes their R2
List caches and Connection objects. Run it only against a disposable stack.

A dedicated local stack avoids the existing development database. See
[README.md](README.md) for the standard setup. The latest local verification
used a copy of `supabase/` in `/tmp/stremlist-e2e-homecov` with project ID
`stremlist-e2e-homecov` and ports 573xx (Supabase API port 57321), and RustFS
container `stremlist-e2e-homecov-r2` on port 7620:

```sh
E2E_SUPABASE_URL=http://127.0.0.1:57321 \
E2E_R2_ENDPOINT=http://127.0.0.1:7620 \
bun run --cwd apps/e2e test:e2e
```

Cleanup must target only that test stack:

```sh
supabase stop --workdir /tmp/stremlist-e2e-homecov --no-backup
docker stop stremlist-e2e-homecov-r2
```

## Current verification and defects found

On 2026-10-07 the List sync status journeys (STR-58) were added: seven toolkit
tests in `sync-status.e2e.ts` (one AI goal) and five Playwright tests in
`sync-status.spec.ts` (four `local`, one `live-regression`). `baseRoutes()`
answers the page's `/sync-status` poll. The new spec found that
`record_list_refresh` read the clock three times, so a failure run started a
few microseconds after its attempt; the function now reads it once. On
2026-10-08 the List notice button got the name of its List ("Connect again for
Trakt Watchlist"), and that goal and the disconnect goal of `providers.e2e.ts`
were recorded again (3 model calls). After a cleanup of the same day, the
strict replay passed all 58 toolkit tests with 17 replays and zero model
calls, and the Playwright run passed all 87 tests with an isolated stack.

On 2026-10-06 the suite was ported to Accounts, Lists and Providers. Eleven AI
goals were recorded again because their screens changed; the two newsletter
goals replayed their earlier recordings. The three recording runs used 54
model calls in total. Eleven stale cache entries were removed. The strict replay passed all 41
toolkit tests, replayed thirteen recordings, and used zero model calls, retries
and skips. The thirteen cache files parse as JSON and contain no credential
patterns.

The complete Playwright run passed all 74 tests (45 local, 4 live smoke and 25
live regression) with the isolated Supabase/RustFS stack, with no retry or
skip. `supabase/tests/replace_account_config.sql` passed against the same
database. Backend tests passed 687/687. `bunx turbo run typecheck lint test
build format:check` passed.

The port found these points:

- The SQL test inserted a Connection without the new required `redirect_uri`
  column, so the CI step failed. The test now gives one.
- Development builds run the configure page's load effect twice. Tests that
  fail a configuration load now hold the failure until the error shows,
  instead of failing only the first request.
- Chromium counts a selected value against `maxlength` when Playwright fills a
  field, so the title-limit test clears the field first.
- An Account saved without Lists (created to connect a Provider first) did
  not get the reinstall message when its first List was saved, although the
  manifest gained Catalogs. The reinstall decision now treats an empty List
  set as a known baseline (`apps/frontend/src/lib/reinstall.ts`, unit test in
  `apps/frontend/scripts/reinstall.test.ts`). `configure-page.spec.ts` and
  `configuration-recovery.e2e.ts` check the message.

Earlier regressions on this PR fixed failed lookup being treated as an existing
account, reinstall baselines after new row IDs, edits lost during saves,
refresh metadata causing false unsaved changes, newsletter errors reported as
success, and schema errors shown as `[object Object]`. Their tests remain in
the current inventory, ported to the new screens.

### Provider journeys (2026-10-07)

Phase B added `toolkit/providers.e2e.ts` (ten tests, three AI goals) and
`tests/provider-journeys.spec.ts` (seven `local` tests). The new goals used
nine model calls to record. The full strict toolkit replay and the full
Playwright run passed twice in a row with the isolated stack. These checks
found no new defect in the Provider code. One display point remains: an
MDBList list saved by numeric ID (`lists/4242`) shows `4242/undefined` as
its detail on the configure page, so the toolkit asserts its title only.

### Home redesign and coverage audit (2026-10-08)

The Home, Changelog and Terms redesign broke four toolkit tests and two
Playwright tests: they used the removed "I already have one" button, the old
headline and the removed default hint. They now use "Open it", the new
headline and an empty hint. One AI goal ("returning users can open
configuration") was stale and was recorded again with 4 model calls. A second
recording run made zero model calls and replayed all 16 entries. No cache
entry was orphaned, so none was deleted. The 16 cache files contain no
credentials.

The audit added `toolkit/home.e2e.ts` (five tests: Home sections, live count,
"Open it" errors, Terms and Changelog links, Home field entries), two
`providers.e2e.ts` tests (kill switch, Letterboxd) and three `local`
Playwright tests (Simkl and MDBList OAuth, every Trakt Action intent, kill
switch). Results on the isolated stack: strict replay 58/58 with 16 replays
and zero model calls; Playwright 85/85 (56 local, 4 live smoke, 25 live
regression) with no retry or skip; `bunx turbo run typecheck lint test build
format:check` 15/15 tasks (backend 693/693, frontend 8/8). No product defect
was found.

## Known limits

- IMDb validation currently classifies some upstream HTTP/network failures as
  `not_found`. This is inherited in the scraper and its unit contracts. The
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
