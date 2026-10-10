# User-journey coverage

The current inventory contains 108 tester-army browser tests and 127 Playwright
integration tests (96 `local`, 4 `live-smoke`, 27 `live-regression`). This
inventory maps supported routes and domain actions to tests. It is not a claim
that every possible input or external-service condition is covered. CI remains
strict, read-only and credential-free for AI replay.

The words follow [CONTEXT.md](../../CONTEXT.md): an **Account** has an Addon
URL with a generated Account ID (`sl_…`), or a **Legacy alias** (`ur…`) for
installs made before Accounts. An Account configures **Lists**; each List
points to one or more **Source lists** on **Providers** (a **Merged List**
when there are several) and produces **Catalogs**.

The toolkit uses `e2e@0.17.0`, `@e2e-dev/web@0.12.0` (exact versions in
`package.json`, see "Cache rules"), and the ChatGPT subscription model
`gpt-6-luna`. Eighteen tests contain twenty bounded AI goals. Exact locator
and payload assertions decide whether each recording is accepted. The remaining
ninety toolkit tests use deterministic actions for timing, error
boundaries and page content.

## Coverage matrix

Paths in the toolkit column are relative to `toolkit/`; integration paths are
relative to `tests/`. Existing integration coverage is listed so that another
mocked browser test is not mistaken for a missing feature.

| Route or user action                                            | Toolkit checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Real handler/storage/client checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Remaining external limit                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `/`, `/terms`, `/changelog`, unknown URL                        | `ui.e2e.ts`: headings, return-home navigation; `home.e2e.ts`: Terms and Changelog section links ("On this page"), site links, "Back to Home"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `home-onboarding.spec.ts`: unknown-route recovery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | External support/donation destinations are links, not payment tests                                       |
| Home sections (redesign)                                        | `home.e2e.ts`: Providers diagram (every Provider, Letterboxd "Soon"), section headings, live count (plural, singular, hidden at 0 or on error), Troubleshooting accordion, Addon Manager and terms links                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `addon-api.spec.ts`: `/stats` counts active Accounts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | The Stremio preview and the beams are decoration; posters load from an external CDN                       |
| New setup from a pasted link (Home or Configure)                | `ui.e2e.ts`: Provider detection hints (Letterboxd: coming soon), Addon URL detection, empty hint after reset; `home.e2e.ts`: "Build my Stremlist" opens an empty setup; profile URL to canonical `ur…` and first save to Account ID install links; private/unknown/offline link refusals                                                                                                                                                                                                                                                                                                                                                                                                                                       | `home-onboarding.spec.ts`: live link, first save creates the Account, install links; unknown and unrecognized links; `addon-api.spec.ts`: `/links/resolve` for public, private, unknown, `p.` handle, chart, unrecognized and MDBList needs-Connection; new Account creation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | IMDb can change public fixtures                                                                           |
| Returning install and switching Account                         | `ui.e2e.ts`: open by Addon URL ("Open it"), old `?userId=` link to the Legacy alias view; `home.e2e.ts`: "Open it" refuses other text, an Addon URL pasted in the main field opens its install; `account-newsletter.e2e.ts`: go home, open another Addon URL, discard the old draft and load the new filters                                                                                                                                                                                                                                                                                                                                                                                                                   | `configure-page.spec.ts`: Addon URL (`stremio://`) in "Open it" for an Account and a Legacy alias; `home-onboarding.spec.ts`: `?userId=` redirect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | No account login exists in this app; the Addon URL is the credential (ADR 0001)                           |
| `/configure` entry and loading                                  | `configuration-recovery.e2e.ts`: invalid/private/unknown/offline link, then canonical profile and first save; `ui.e2e.ts`: missing Account, load retry, failed lookup never becomes a new setup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `configure-page.spec.ts`: real load, failed-load retry, unknown Account ID and Legacy alias                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | None for the local workflow                                                                               |
| List add/edit/remove and link normalization                     | `ui.e2e.ts`: duplicate link refused, title edit, removing every List disables Save, ten-List limit; `configuration-recovery.e2e.ts`: unrecognized link, pasted list URL, canonical duplicate refusal and repair                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `configure-page.spec.ts`: live list link and chart add/remove, first List of an Account saved without Lists asks for a reinstall; `configuration-transitions.spec.ts`: saved removal/reload, retired URL empty, 61-character title refused by the API and capped by the field                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Handle normalization uses a fixture for the canonical collision                                           |
| Built-in charts and content type                                | `ui.e2e.ts`: add chart, disabled duplicate menu item, IMDb and Trakt charts up to the limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `configuration-transitions.spec.ts`: movie-to-TV chart change keeps List ID, persists series mode, updates manifest and reloads; `addon-api.spec.ts`: content modes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Live chart contents are structural assertions, not fixed rankings                                         |
| List order and titles                                           | `ui.e2e.ts`: pointer reorder, exact saved positions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `configuration-transitions.spec.ts`: default titles renumber after reorder, survive reload, manifest order matches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | None for local persistence                                                                                |
| Sort/filter/search                                              | `ui.e2e.ts`: genre/preset save/clear; `configuration-recovery.e2e.ts`: saved genre absent from available choices can be cleared                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `catalog-features.spec.ts`: combined filters/reload/clear, accented and URL-sensitive search, stable shuffle pagination; `addon-api.spec.ts`: all sort options; `configuration-transitions.spec.ts`: empty results recover after removing one filter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Hosted Stremio UI can change                                                                              |
| Extra preset catalogs                                           | `ui.e2e.ts`: enable and preserve preset when clearing filters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `catalog-features.spec.ts`: all three presets in Stremio after reinstall; `configuration-transitions.spec.ts`: disable all, preserve genre, remove manifest entries and retire old preset URLs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | None for local protocol behavior                                                                          |
| Save errors and concurrent edits                                | `ui.e2e.ts`, `save-refresh.e2e.ts`: HTTP retry, in-flight add/edit/remove/reorder, metadata-only refresh vs real edit; `configuration-recovery.e2e.ts`: network retry and normalized-source save baseline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `configuration-transitions.spec.ts`: invalid title does not mutate storage; corrected title persists; `addon-api.spec.ts`: invalid configurations, including a Source list that needs a missing Connection, keep storage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Browser teardown before an acknowledged save is not a durability guarantee                                |
| Save button and reinstall in Stremio                            | `ui.e2e.ts`, `providers.e2e.ts`, `configuration-recovery.e2e.ts`: a save that changes Catalogs or Actions says to reinstall, and later saves keep that message until the reinstall; legacy moved install keeps every Save off                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `configure-page.spec.ts`: sort order and RPDB key save without a reinstall; a new catalog title shows the notice before saving, then the reminder with a Stremio Web Reinstall link, which stays after a reload and another save and ends with "I did it"; the Reinstall action of the save toast opens Stremio Web and ends the reminder; the floating Save button shows and saves once the top Save scrolls away                                                                                                                                                                                                                                                                                                                                                                 | Stremio itself is not reinstalled; the reminder is kept per browser (`localStorage`)                      |
| Manual refresh                                                  | `ui.e2e.ts`: partial failure/success; `refresh-recovery.e2e.ts`: HTTP/network recovery preserves draft, server throttle, cooldown expiry then next refresh                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `configure-page.spec.ts`, `addon-api.spec.ts`: real refresh and server throttling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | IMDb outage classification remains limited, see below                                                     |
| List sync status and Connection renewal                         | `sync-status.e2e.ts`: synced and failing rows (one and no titles, older titles from a date), the copy and fix of each failure reason, attention count, polling until a first refresh and no poll after it, manual refresh, Legacy alias rows and poll, no status on a new setup, a changed chart is "Not saved yet" and is polled only after the save, refused or missing Connection (AI goal: renew from the List), one "Connect again for <List>" button per List, recovery after a new Connection, an open Catalog preview read again when a poll finds the Connection refused, the reinstall notice and reminder next to a changed chart                                                                                   | `sync-status.spec.ts`: a failed refresh keeps the last success and the refresh answer has the statuses; a refused Connection gets `needs_renewal_since` and public Trakt Lists do not fail with it; Legacy alias `/sync-status` and 404 for an unknown Addon URL; status from the cache; live IMDb chart first refresh by polling. `provider-sync-status.spec.ts`: a refused refresh marks the Connection, a new OAuth authorization clears the mark and reads the List again with the new token; a working read clears a mark; a disconnect forgets the statuses of private Lists only; a Catalog preview through a refused Connection marks it for renewal and records no sync status. `catalog-preview.spec.ts`: a preview of a saved List records no sync status               | The poll limit (two minutes) and the hidden-tab pause are not run: they depend on time and tab visibility |
| RPDB                                                            | `ui.e2e.ts`: show/hide                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `configure-page.spec.ts`: save/clear; `addon-api.spec.ts`: rewritten poster URLs, key on Account creation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | No valid sandbox key is available to prove authenticated poster delivery                                  |
| Installation and clipboard                                      | `ui.e2e.ts`: Stremio Web install link of a new Account (a local HTTP Addon URL has no `stremio://` link), Addon URL copy denial                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `configure-page.spec.ts`: real clipboard success and denial; `stremio-install.spec.ts`: install/uninstall hosted Stremio with an Account ID and with a Legacy alias                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | OS handling of the `stremio://` protocol is not automated                                                 |
| Legacy alias installs                                           | `ui.e2e.ts`: old `?userId=` link, upgrade card, Actions locked; `providers.e2e.ts`: Connect points to the upgrade, upgrade to a private Addon URL and open it, a moved install cannot be changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `addon-api.spec.ts`: first manifest creates the legacy Account and its watchlist List, historic manifest ID; private Addon URL manifest hides the Account ID; configure redirect for both keys; `provider-connections.spec.ts`: no private List or Connection through the alias, upgrade copies Lists without the Connection, moved install refuses saves; `provider-actions.spec.ts`: no Action through the alias                                                                                                                                                                                                                                                                                                                                                                 | None for local behavior                                                                                   |
| Provider links (Trakt, JustWatch, SensCritique, MDBList, Simkl) | `providers.e2e.ts`: link hints, detected Provider, rows and first-save payload for Trakt, JustWatch, SensCritique and IMDb links; Trakt chart from Quick add; a Letterboxd link shows the MDBList import steps without a lookup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `provider-links.spec.ts`: real adapters resolve public links and refusals (private, not found), Catalogs from fixture data, SensCritique IDs resolved through Wikidata; MDBList list and Simkl plan to watch read through a seeded Connection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Provider APIs are fixtures; their real responses can change                                               |
| Connect a Provider (OAuth)                                      | `providers.e2e.ts`: a link that needs a Connection saves the setup, connects (authorize page intercepted), comes back and adds the link; Connection sources in Quick add; denied/expired/failed returns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `provider-connections.spec.ts`: start URL and PKCE challenge, callback token exchange with the verifier, encrypted Connection with username, one-time state, denied and invalid callbacks, Connection sources, private `me/` List served with the new token; Simkl and MDBList start and callback store their Connection                                                                                                                                                                                                                                                                                                                                                                                                                                                           | No real Provider login; authorize pages are not loaded                                                    |
| Disconnect, expired Connection, private Lists                   | `providers.e2e.ts`: confirm and cancel, disconnect, "Connect again" card, Actions cleared on save, Connect again starts OAuth                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `provider-connections.spec.ts`: revoke request, Connection row and cached Catalog removed, needs-Connection card; expired token refreshed with the stored redirect URI, or card when the refresh is refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | None for local behavior                                                                                   |
| Actions from Stremio                                            | `providers.e2e.ts`: Actions toggle, Provider order and choice saved, reinstall message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `provider-actions.spec.ts`: `stream` resource in the manifest, Action entry URL, Action page performs the Trakt watchlist write; no entries through a Legacy alias or after disconnect; every Trakt intent (watchlist add/remove, episode watched/unwatched, rating form, rate and remove) sends its write and updates the entries; unknown intents and Accounts get "This link does not work"                                                                                                                                                                                                                                                                                                                                                                                     | Stremio's own stream list UI is not driven; Simkl and MDBList writes are unit-tested only                 |
| Provider kill switch (`DISABLED_PROVIDERS`)                     | `providers.e2e.ts`: a Provider that is off shows "Temporarily unavailable", has no Connect button or Quick add charts, and its links are refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `provider-actions.spec.ts`: a backend with Providers off reports them, refuses their links, keeps the cached Catalog, shows the disabled card without a cache, refuses Connect and own lists, gives no Action entries, and sends no Provider request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | None for local behavior                                                                                   |
| Stremio Discover, Board, details and metadata                   | Frontend only supplies installation links                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `stremio-catalogs.spec.ts`, `stremio-meta.spec.ts`, `catalog-features.spec.ts`: navigation, filters, cards, movie metadata and series delegation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Hosted client and live IMDb require network                                                               |
| Newsletter                                                      | `ui.e2e.ts`: email validation, success, rejection/offline; `account-newsletter.e2e.ts`: pending submit lock, error retry, already-subscribed confirmation and input reset                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `provider-contract.spec.ts`: actual Resend SDK and HTTP handler, success/duplicate/422/401/503/network outcomes, browser error-to-success recovery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Provider transport is isolated; no real contact is enrolled and no mail delivery is claimed               |
| IMDb private list                                               | Link refusals use intercepted `/links/resolve` answers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `provider-contract.spec.ts`: actual GraphQL request and list classifier behind `/links/resolve` for public/private/FORBIDDEN/missing lists; `addon-api.spec.ts`: live private watchlist and handle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Live private `ls` fixture is absent; provide `E2E_PRIVATE_IMDB_LIST_ID` to include it                     |
| Catalog preview (STR-57)                                        | `catalog-preview.e2e.ts`: an added List opens its preview, a saved one on request; exact `/lists/preview` payloads (new setup, Account, Legacy alias); loading state; "+N more" count; preset Catalogs; each empty Catalog hint (other type, filters, preset); Show hint; Unresolved entries (one, many, "Show all"); Titles without details; private list; Try again after a network error and after "did not answer"; disconnect reads again; opening a preview or changing the sort needs no reinstall, a Show change does; AI goal: the empty TV shows hint leads to Show, then save with the reinstall message and reminder                                                                                               | `catalog-preview.spec.ts`: real SensCritique adapter, Wikidata resolver, `title_id_map` rows and IMDb enrichment; sort, Show and presets; private list; Letterboxd coming soon; no Catalog cache or List change; Legacy alias; configure page titles, Unresolved entries and private message; live IMDb list. `provider-sync-status.spec.ts`: a Trakt read through a Connection serves only its Account (not another Account or a new setup), is reused for a new sort and not after a disconnect; `provider-actions.spec.ts`: the kill switch refuses previews                                                                                                                                                                                                                    | Local SensCritique, Wikidata and IMDb answers are fixtures; only the live run reads IMDb                  |
| Merged Lists (several Source lists in one Catalog)              | `merged-lists.e2e.ts`: merge a List into another (AI goal) with the exact saved payload and label; keyboard merge keeps focus; chart merge turns off Date added and TV shows only with their reasons; a movie chart and a TV chart must show both; move a Source list to its own List and remove one, exact payload; moving is off with 10 Lists; a promoted Source list keeps its name; focus moves to the Source lists when no List is left to merge; five-Source-list limit; 20 Source lists per Account (Quick add chart, Trakt chart, link); a merged Source list cannot be added again; a merged Source list without its Connection shows "Not connected"; a 409 "changed in another window" keeps the merge for a retry | `merged-lists.spec.ts`: one Title per IMDb ID sorted by date added, no date served, one manifest Catalog, meta from a merged cache; a Title shared by IMDb and Trakt shows once with both link backs and the genres of both; a failing Source list leaves the others, all failing shows the card; Legacy alias hides and refuses a Connection Source list; API rules keep storage, including 21 Source lists in an Account (backend unit tests cover the refused concurrent save); a save without `mergedSources` keeps them and their labels; saves delete unused R2 caches; configure-page merge persists after reload; removing a merged Source list asks for a reinstall only when the manifest genres change, and merging a List always does                                  | Live Provider dates are covered by adapter unit tests, not live E2E                                       |
| Addon cache and unavailable content                             | Not duplicated with browser API mocks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `addon-api.spec.ts`: R2 generations/tombstone, unavailable cards, malformed catalogs; seeded transitions check removed URLs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Production CDN behavior is not simulated                                                                  |
| New titles catalog (ADR 0007)                                   | `new-titles.e2e.ts`: toggle saves `newTitles` and asks for a reinstall (reminder kept), the reinstall notice follows the toggle before a save, summary with waiting Lists, change during a save, unreadable history, new setup sends it, moved Legacy alias install locked; a refresh updates the summary and a throttled one keeps it; a save and a disconnect show the summary of what is left                                                                                                                                                                                                                                                                                                                               | `new-titles.spec.ts` (isolated backend, controlled Source lists): first refresh is the Baseline; additions show once, newest first, with date and List; a failed or page-capped read changes nothing and the List waits (configure page text); an Unresolved entry blocks nothing; a Title that leaves and comes back keeps its first detection; a removed and re-added List keeps its Baseline; series catalog, no search, `skip`; meta route; a Legacy alias private copy keeps the setting with its own Baseline; a disconnect forgets only Connection history; a merged List detects in each Source list, shows a Title once and waits for the Baseline of each; Legacy alias hides Connection Lists; configure page (accessible description), manifest and catalog on and off | Real Provider transport is replaced; Provider reads are covered by the other specs                        |

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
view, `baseRoutes()` (answers `/providers`, `/stats` and the Catalog preview
that an added List opens, with `previewOf()`, and fails the test on any other
request that no later route takes), `captureConfig()` (`baseRoutes()`, then
`routeConfig()`, which records saves, echoes the saved Lists like the backend
and serves `state.config`, so a test can change it while the page is open),
`gatedSaves()` (holds each save until the test releases it),
`routeCreateAccount()` for the first save of a new setup,
`routePreview()` for `/lists/preview`, `routeConnectionSources()` and
`routeConnectStart()` for a Connection's Source lists and a Trakt
authorization, `ago()` for relative times, `routeResolve()` for
`/links/resolve`, the exact save messages, `saveButton()` (the Save button at
the top: the floating Save button has the same name and stays in the page
while it is hidden) and `holdToasts()` (keeps toasts on screen, so a check
after an AI goal does not depend on the model's speed). Register
`baseRoutes()` first: routes run newest first.

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

The end state must not depend on the scroll position, which differs between
machines. A test whose AI goal acts on or ends on the configure page calls
`fitConfigurePage` before it opens the page: the page then cannot scroll, so
the floating Save button stays hidden and "Save" names one button. A goal
that checks a toast calls `holdToasts`. `holdToasts` reports a hidden
document, and the page does not poll `/sync-status` while it is hidden: a
test that waits for a poll must not call it.

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

`catalog-preview.spec.ts`, `new-titles.spec.ts` and the four `provider-*.spec.ts`
files (`provider-links`, `provider-connections`, `provider-actions`,
`provider-sync-status`) each start their own fixture backend in `beforeAll`
with `startFixtureBackend`, so the resolver cache (`title_id_map`), the
detection history and the absence of a Catalog cache are checked in real
storage. Playwright runs one worker, so the files never share a fixture
backend.

The harness seeds controlled state through `helpers/db.ts` (service-role
client, loopback databases only). Specs never use the client itself; they
call these seeders and readers:

- `seedAccount()` / `seedAccount({ legacyImdbUserId, newTitlesCatalog,
actions })`: a private Account or a Legacy alias Account, with no
  save-triggered prewarm; `actions` turns Actions on with these Providers.
- `seedImdbAccount(sourceRef, catalogTitle)`: a private Account with one IMDb
  List.
- `seedList(accountId, { provider, sourceRef, mergedSources, … })` and
  `seedAccountWithLists([...])`: List rows for any Provider, merged or not.
- `helpers/r2.ts` `sourceCacheKey(listId, source)`: the cache key of one
  Source list of a merged List, for `seedCachedCatalog()` and R2 checks.
- `seedConnection(accountId, provider, { expiresAt, refreshToken,
needsRenewalSince, … })`: a Connection with synthetic tokens, encrypted
  with the public test `CONNECTION_ENCRYPTION_KEY` of `env.ts` (the
  Playwright backend gets the same key) and the required `redirect_uri`.
- `clearResolverCache(namespace, externalIds)` and `getResolverRows(…)`: the
  ID resolver cache; `getSourceListSyncs(accountId)` and
  `getSourceListEntries(accountId)`: the detection history;
  `getOAuthStates(state)`: pending authorizations.
- `helpers/provider-backend.ts` `startProviderBackend(preload, env)`: a
  second backend on a free loopback port with only the given variables.
- `helpers/fixture-backend.ts` `startFixtureBackend(preload, extraEnv)`: a
  `startProviderBackend` with the shared environment of the fixture backends
  (local Supabase and RustFS, dummy Trakt, Simkl and MDBList client IDs, no
  TMDB key). It returns `{ url, api, requests, clearRequests, authorize,
stop }`: `api` is the API client of that backend, `requests(match)` reads
  the Provider requests that the preload logged, and `authorize(accountKey,
provider)` starts an authorization and comes back to the OAuth callback
  with the fixture code.
- `helpers/fetch-fixture.ts` `installFetchFixture({ hosts, log })`: the
  shared transport of the preloads. It passes loopback requests (Supabase)
  to the real fetch, reads each body once, logs the request, sends it to the
  handler of its host and refuses every other host. `graphql(body)` reads
  the operation name and variables of a GraphQL request.
- `helpers/provider-fixtures.ts`: the preload of the `provider-*.spec.ts`
  files and `catalog-preview.spec.ts`.
  It answers Trakt, MDBList, Simkl, JustWatch, SensCritique, Wikidata and
  IMDb title requests with fixed data, passes loopback requests (Supabase)
  to the real fetch, refuses every other host and logs each Provider request
  to `E2E_PROVIDER_LOG`. It accepts the tokens `fixture-access-token` (the
  `seedConnection` default) and `fresh-access` (from the code
  `fixture-code`); the refresh token `rejected-refresh` is refused.
- `helpers/catalog-fixture.ts` `seedCatalog()`: a private Account whose List
  reads a synthetic IMDb watchlist cached in RustFS.
- `helpers/api.ts`: `apiAt(baseUrl)` returns the readers and writers of one
  backend (`createAccount`, `postConfig`, `resolveLink`, `upgrade`,
  `bootstrapLegacy`, the catalog, meta, manifest and stream readers, the
  Catalog preview, Connections and the OAuth callback). `api` and the named
  exports are those of the Playwright backend. `listInput(provider,
sourceRef, extra)` builds one List of a save payload.

`resetDb()` deletes the Legacy alias Accounts of the fixtures and every Account
created since the run started (`E2E_RUN_STARTED_AT`), after it removes their R2
List caches and Connection objects. Run it only against a disposable stack.

A dedicated local stack avoids the existing development database. See
[README.md](README.md) for the standard setup. The latest local verification
used a copy of `supabase/` in `/tmp/stremlist-e2e-str60m` with project ID
`stremlist-e2e-str60m` and ports 594xx (Supabase API port 59421), and RustFS
container `stremlist-e2e-str60m-r2` on port 7660:

```sh
E2E_SUPABASE_URL=http://127.0.0.1:59421 \
E2E_R2_ENDPOINT=http://127.0.0.1:7660 \
bun run --cwd apps/e2e test:e2e
```

Cleanup must target only that test stack:

```sh
supabase stop --workdir /tmp/stremlist-e2e-str60m --no-backup
docker stop stremlist-e2e-str60m-r2
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

On 2026-10-08 this branch took the Home redesign and its E2E repairs (#59).
The merge had conflicts only in the counts of `README.md` and this file; no
cache file conflicted, and the strict replay then passed all 65 toolkit tests
with 17 replays. A coverage audit of STR-58 added five toolkit tests in
`sync-status.e2e.ts` (failure reasons, one Connect button per List, Legacy
alias, new setup, changed chart), two `local` Playwright tests in
`provider-journeys.spec.ts` (renewal by a new authorization; clear on a
working read and forget on disconnect) and checks of the refresh answer and of
404 in `sync-status.spec.ts`. It found one defect: a saved List whose chart
changed showed "Not refreshed yet" and the page polled `/sync-status` for up
to two minutes, before the change was saved. The page now remembers the
saved Source list of each List, so such a row is "Not saved yet" and is
polled only after the save. No AI goal was added or changed: two recording
runs made zero model calls (17 replays each), and no cache entry was stale or
orphaned. Results: strict replay 70/70 with 17 replays and zero model calls;
Playwright 92/92 (62 local, 4 live smoke, 26 live regression) with no retry
or skip; both SQL tests pass; `bunx turbo run typecheck lint test build
format:check` 15/15 tasks (backend 742/742, frontend 8/8).

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

### Base merge: toasts, floating Save and reinstall reminder (2026-10-08)

The base branch moved save and newsletter results to toasts, put the Save
button at the top of the Lists column with a floating copy at the bottom, and
added a reinstall notice and reminder. These changes broke tests:

- Two buttons are named "Save". The toolkit `saveButton()` and the Playwright
  `helpers/configure.ts` take the first one, at the top. The recorder stores a
  position for a "Save" tap, and the "catalog filters" test uses a tall
  viewport so that its recordings replay the same way.
- The reinstall message is now "Saved! Reinstall Stremlist in Stremio to see
  your changes." It stays on later saves until the user reinstalls, so tests
  that save twice expect it on the second save too.
- A local HTTP Addon URL has no `stremio://` link, so the "Install in Stremio"
  checks expect no link.
- Results close after 6 to 10 seconds. A stale replay waits about 12 seconds
  for its end state, so the toast was gone when the agent took over, and the
  goal failed. `holdToasts()` keeps toasts on screen in the tests that check
  one after an AI goal.
- Controls were renamed ("Connected to Trakt. Disconnect", "Close toast").

Six AI goals were recorded again (newsletter success and retry, unrecognized
link, Quick add chart and both catalog filters goals). Two more were recorded
again while the tests were fixed (Provider disconnect, profile URL), and one
recording was refreshed (saved genre). The recording runs made 13, 22, 11 and
7 model calls; the last recording run made zero model calls and replayed all
16 entries. No entry was orphaned. New `local` Playwright tests in
`configure-page.spec.ts` cover the notice and the reminder (also after a
reload and a save that changes nothing), the absence of both for a sort or
RPDB-only save, the Reinstall action of the toast and the floating Save
button. Results on the isolated stack: strict replay 58/58 with 16 replays;
Playwright 88/88 (59 local, 4 live smoke, 25 live regression) with no retry;
`bunx turbo run typecheck lint test build format:check` 15/15 tasks (backend
698/698, frontend 16/16); the SQL test passed. No product defect was found.

### Catalog preview coverage (2026-10-08)

After the merge of the Home redesign and of its coverage audit, the strict
replay passed 65/65 with 16 replays. The audit of the Catalog preview added
five toolkit tests to `catalog-preview.e2e.ts` (loading state, "+N more",
preset Catalogs and every empty Catalog hint; one Unresolved entry and Titles
without details; "did not answer" with Try again; the Legacy alias key; and
one AI goal that follows the empty TV shows hint to Show, then saves) and two
`local` Playwright tests (a Trakt preview through a Connection serves only its
Account, and Letterboxd is coming soon). The kill switch test also checks the
preview. The new goal used 7 model calls to record. A second recording run
replayed all 17 entries with zero model calls. No cache entry was orphaned.
Results on the isolated stack: strict replay 70/70 with 17 replays and zero
model calls; Playwright 94/94 (64 local, 4 live smoke, 26 live regression)
with no retry or skip; `bunx turbo run typecheck lint test build
format:check` 15/15 tasks (backend 720/720, frontend 8/8). No product defect
was found.

### Base merge: reinstall reminder and Catalog preview (2026-10-08)

The base branch added toasts, the floating Save button and the reinstall
reminder. Two Catalog preview tests broke: the disconnect control is now
"Connected to Trakt. Disconnect", and the recording of the empty TV shows hint
goal no longer replayed (`REPLAY_STALE`, end mismatch). The preview only reads,
so it does not change what counts as a Catalog change: the "sort and Show"
test now checks that opening a preview or changing the sort shows no
reinstall notice and that Show does, and the AI goal checks the reinstall
message and the reminder after its save (with `holdToasts()`). The first
recording run made 2 model calls but did not keep the entry, the second made
7 and wrote it, and the third made zero model calls and replayed all 17
entries. No entry was orphaned. Results on the isolated stack: strict replay
70/70 with 17 replays; Playwright 97/97 (67 local, 4 live smoke, 26 live
regression) with no retry; `bunx turbo run typecheck lint test build
format:check` 15/15 tasks (backend 725/725,
frontend 16/16); the SQL test passed. No product
defect was found.

### Base merge: Catalog preview and reinstall reminder into sync status (2026-10-09)

The base branch added the Catalog preview (STR-57), the toasts, the floating
Save button and the reinstall reminder. The merge had conflicts in the docs,
the `/sync-status` and `/lists/preview` answers of `baseRoutes()`, the
Providers panel (the base merged "Connected" and "Disconnect" into one
button; a Connection that needs renewal keeps its "Connect again" and
"Disconnect" buttons), the List row (sync status and preview), the refresh
error (now a toast) and the backend read (`providerContext` and
`sourceProblemReason` of the base replace this branch's copies). The
recording of the Provider disconnect goal no longer replayed (end mismatch:
the List now shows "Not connected" and the page shows the reinstall notice);
it was recorded again with 1 model call. The second recording run made zero
model calls and replayed all 18 entries. No entry was orphaned. The renewal
goal of `sync-status.e2e.ts` now calls `fitConfigurePage`, and its saves use
`saveButton()`.

The check of how the sync status and the Catalog preview work together found
one defect: when a poll found the Connection of a List refused, the row asked
to renew it, but its open preview kept the Titles of an earlier read. The
preview now reads again when the renewal mark of the Connection comes or goes
(`Configure.tsx`, `connectionKeyOf`). A toolkit test covers it, and the
chart-change test checks the reinstall notice and reminder next to "Not
saved yet". Two Playwright checks show that a preview is not a refresh (no
sync status) and that a preview through a refused Connection marks it for
renewal. Results on the isolated stack: strict replay 83/83 with 18 replays
and zero model calls, twice; Playwright 105/105 (74 local, 4 live smoke, 27
live regression) with no retry; both SQL tests pass; `bunx turbo run typecheck lint test build format:check` 15/15 tasks (backend 774/774, frontend 16/16).

### Merged Lists coverage (2026-10-08)

The STR-59 branch now includes the Home redesign and its E2E repairs. The
audit added five deterministic tests to `toolkit/merged-lists.e2e.ts`
(Account limit of 20 Source lists, moving off with 10 Lists, a movie chart
and a TV chart, a missing Connection in a merged List, a 409 save) and three
`local` Playwright tests (Titles shared by two Providers, a save without
`mergedSources`, the reinstall gap below), plus a 21-Source-list case in the
API rules test. No AI goal was added or changed, so no cache entry was
recorded again or deleted. The record run and a second run in record mode
over the full toolkit replayed all 17 entries with zero model calls. The
strict replay passed 70/70 with zero model calls. On an isolated
Supabase/RustFS stack, Playwright passed 94/94 (65 local, 4 live smoke, 25
live regression) with no retry or skip, and
`supabase/tests/replace_account_config.sql` passed. `bunx turbo run
typecheck lint test build format:check` passed 15/15 tasks (backend
733/733, frontend 8/8).

Defects found:

- Fixed: when the Account had 20 Source lists, an IMDb chart from Quick add
  did nothing and showed no message (Trakt charts and links showed the
  limit). The page now shows the limit message for IMDb charts too.
- Fixed later (see the next section): removing a merged Source list that is
  not the first changed the genre options of the manifest Catalog without a
  reinstall message, and removing the first one asked for a reinstall even
  when the manifest stayed the same.

### Base merge: Catalog preview and sync status into merged Lists (2026-10-09)

The base branch added the Catalog preview, the sync status of each List,
toasts, the floating Save button and the reinstall reminder. Merged Lists
now work with each of them:

- A read of one Source list records its sync status under the List, not
  under its cache key (the database refused those rows before). The API
  sends the status of each Source list in `syncStatus`, in the List's
  order; the row shows the problem of one Source list, says
  whether the others still show, and "Connect again" connects that Source
  list's Provider. A disconnect forgets only the Source lists read through
  that Connection, and a new authorization reads them again.
- The Catalog preview reads every Source list, shows each Title once and
  names a Source list that it cannot read.
- The reinstall signature is the manifest Catalogs (ID, name, type, genre
  options), built with the same code as the manifest
  (`@stremlist/shared/manifest-catalogs`) and the genres of each Source list
  (`sourceGenres`). Removing a Source list asks for a reinstall only when it
  takes genres away; merging a List always does, because a Catalog goes away.

New tests: four toolkit tests in `merged-lists.e2e.ts` (preview of a merged
List, a refused Connection of one Source list, the oldest refresh, the
reinstall notice), two Playwright tests in `merged-lists.spec.ts` (remove a
Source list with and without a genre of its own, merge a List) and one in
`provider-journeys.spec.ts` (sync status of each Source list through a
refused Connection, a new one and a disconnect). The AI goal of
`merged-lists.e2e.ts` now calls `fitConfigurePage` and `holdToasts`; its
recording no longer replayed (end mismatch) and was recorded again with 1
model call. The second recording run made zero model calls and replayed all
19 entries. No entry was orphaned. Results on the isolated stack: strict
replay 99/99 with 19 replays, twice; Playwright 116/116 (85 local, 4 live
smoke, 27 live regression) with no retry; both SQL tests pass; `bunx turbo run
typecheck lint test build format:check` 15/15 tasks (backend 832/832,
frontend 16 + 12).

Defects found and fixed: the sync statuses of merged Source lists were never
recorded (their cache key is not a List ID); several add-list errors in a row
stacked one toast each.

### New titles coverage (2026-10-08)

The merge of the Home redesign coverage fixed the four toolkit tests and the
two Playwright tests that the redesign broke. The audit of the "New titles"
catalog (ADR 0007) added five `local` Playwright tests to
`new-titles.spec.ts`: a read cut short by the page cap (the fixture's
`capped` IMDb watchlist) is served but never compared, and the configure page
says that the List waits; a Title that leaves and comes back keeps its first
detection, also when its List is removed and added again; the series catalog,
search and `skip`; the private copy of a Legacy alias keeps the setting and
starts its own Baseline; a disconnect forgets only the Connection history. It
added two toolkit tests: a refresh updates the summary and a throttled one
keeps it, and a save and a disconnect show the summary of what is left. No AI
goal was added. The record command replayed all 17 entries with zero model
calls, twice. No entry was stale or orphaned, so none was recorded again or
deleted.

Results on the isolated stack: strict replay 66/66 with 17 replays and zero
model calls; Playwright 95/95 (66 local, 4 live smoke, 25 live regression)
with no retry or skip; both SQL tests passed; `bunx turbo run typecheck lint
test build format:check` 15/15 tasks (backend 722/722, frontend 9/9). No
product defect was found.

### Base merge: Catalog preview, sync status and merged Lists into New titles (2026-10-09)

The base branch added the Catalog preview, the sync status of each List,
toasts, the floating Save button, the reinstall reminder and merged Lists.
New titles now work with each of them:

- `replace_account_config` of the New titles migration was rebuilt from the
  merged Lists version: before, the later migration replaced it and dropped
  `merged_sources`, `source_label` and the stale merge check.
- The "New titles" Catalogs are built in `@stremlist/shared/manifest-catalogs`
  (`addonCatalogEntries`), so the manifest and the reinstall signature use
  the same entries. Turning the setting on or off shows the reinstall notice
  and keeps the reminder; with the setting off the signature has its old
  format, so stored reminders still match.
- Each Source list of a merged List keeps its own history. The catalog reads
  every Source list's history and cache, a Title that two Source lists add
  is one new title, a Source list that fails or is cut short is not compared
  while the others are, and a List waits while one of its Source lists has no
  Baseline. A Catalog preview never records a Synchronization.

New tests: one toolkit test (the reinstall notice follows the setting), one
`local` Playwright test (merged List detection against real storage). The AI
goal of `new-titles.e2e.ts` now calls `fitConfigurePage` and `holdToasts`;
its recording no longer replayed (end mismatch) and was recorded again with
1 model call. The second recording run made zero model calls and replayed all
20 entries. No entry was orphaned. Results on the isolated stack: strict
replay 108/108 with 20 replays, twice; Playwright 127/127 (96 local, 4 live smoke, 27 live regression) with no retry (a first run lost the network and failed 17 live tests on DNS; the rerun passed); all three SQL
tests pass; `bunx turbo run typecheck lint test build format:check` 15/15
tasks (backend 870/870, frontend 16 + 15).

Defects found and fixed: the New titles migration removed the merged Lists
rules from `replace_account_config`; the New titles catalog ignored every
Source list of a merged List but the first; the reinstall signature did not
count the New titles Catalogs after the base change.

### Review fixes: shared helpers and the Provider spec split (2026-10-10)

A code review found copied helpers across the harness. The fixes keep every
test title, tag, goal text and cache entry:

- `tests/provider-journeys.spec.ts` (15 tests) is now four files by subject:
  `provider-links.spec.ts` (2), `provider-connections.spec.ts` (5),
  `provider-actions.spec.ts` (3) and `provider-sync-status.spec.ts` (5). Each
  starts its own fixture backend. The inventory is unchanged: 127 tests
  (96 `local`, 4 `live-smoke`, 27 `live-regression`) with the same titles and
  tags.
- `helpers/api.ts` `apiAt(baseUrl)` and `helpers/fixture-backend.ts`
  `startFixtureBackend(preload, extraEnv)` replace the HTTP clients and the
  three environment blocks of the fixture backends. All fixture backends now
  get the same dummy values (`RESEND_API_KEY=re_e2e_dummy_key`, the Trakt,
  Simkl and MDBList client IDs of `provider-fixtures.ts`, the short refresh
  cooldown). No test depends on a missing client ID there; the Playwright
  backend keeps no Trakt client ID, which `sync-status.spec.ts` needs.
- `helpers/db.ts` no longer exports its client: specs use its seeders and
  readers. `helpers/fetch-fixture.ts` is the one interceptor of both
  preloads. `helpers/configure.ts` has `saveConfigure` and `openConfigure`.
- The toolkit route helpers that several files copied are in
  `toolkit/config-fixture.ts`. The strict replay keeps its 20 recordings and
  makes no model call.

The same review changed the app code. The strict replay found two
regressions of those changes before they were pushed, and both are fixed:

- The sync status of a List is now sent as one array in `listSources` order.
  After a save that changed a chart, the row took the status of the old
  chart at the same position, so the page did not poll ("a saved List whose
  chart changes is not saved yet, and is polled only after the save"). A
  status now counts only for the Source list that it names
  (`statusOfSource`).
- Removing the reinstall check's null genre baseline made a genre filter
  count as a Catalog change for answers without `sourceGenres`, which most
  toolkit fixtures send ("refresh during save preserves a later filter
  edit", "a saved genre missing from refreshed choices can still be
  cleared"). The null baseline is back.

Results on an isolated stack (project `stremlist-e2e-tnr16`, Supabase API
port 61221, RustFS on 7671): strict replay 108/108 with 20 replays and zero
model calls, so no entry was recorded again; Playwright 127/127 (96 local,
4 live smoke, 27 live regression) with no retry; all four SQL tests pass,
with the new `account_writes.sql`; `bunx turbo run typecheck lint test build
format:check` 16/16 tasks (backend 806, shared 102, frontend 3 + 71).

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
