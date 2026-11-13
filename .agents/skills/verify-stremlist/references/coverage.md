# Coverage and delivery criteria

## Existing checks

The commands below reuse the repository's runners. Read installed Turborepo docs before changing task commands or configuration, as required by `AGENTS.md`.

| Check              | Command                                                                                            | What it proves                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| CI baseline        | `bunx turbo run lint:repo typecheck:repo build test --force`                                       | Oxfmt and Oxlint (`vp check`), `bun check` types for every project, production builds, backend and shared Vitest, frontend script tests.     |
| Unused code        | `bun run knip`                                                                                     | No unused files, exports, or dependencies. CI runs it.                                                                                       |
| Repository hygiene | `gitleaks git --redact --no-banner`, `bun audit --prod`, `bunx commitlint --from <base> --to HEAD` | No secrets in the Git history, no known advisory in production dependencies, Conventional Commits. CI runs all three.                        |
| UI journeys        | `bun run test:toolkit:replay`                                                                      | Real frontend interactions, exact HTTP payloads, errors, and replayed actions with zero model calls.                                         |
| Local integration  | `CI=1 bun run --filter @stremlist/e2e test:e2e --project=local --trace on`                         | Real handlers, database, and caches. Provider fixture specs control external transports, but some other local specs trigger real IMDb reads. |
| Live compatibility | Run the same E2E command separately with `--project=live-smoke` and `--project=live-regression`    | Public IMDb behavior and hosted Stremio Web compatibility for tagged tests.                                                                  |
| Atomic SQL writes  | Commands below                                                                                     | Transaction and concurrency invariants in real Postgres.                                                                                     |
| Scraper stress     | `bun run --cwd apps/backend test:stress`                                                           | The existing scraper stress cases, excluded from normal backend tests.                                                                       |
| Formatting         | `bun run format:check`, or `bun run fix` to rewrite                                                | Formatting only. No behavior proof. `bun run lint` also checks it.                                                                           |

Run SQL checks only inside the disposable stack started for this run.

```sh
docker exec -i supabase_db_stremlist psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/replace_account_config.sql
docker exec -i supabase_db_stremlist psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/record_list_refresh.sql
docker exec -i supabase_db_stremlist psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/account_writes.sql
```

For cache, scraper, and throughput changes, consult `apps/backend/stress/README.md` and use its existing load runner. Load tests are not part of a routine documentation change. `bun run knip` checks unused code, and CI runs it.

## Command supervisor checks

Run `python3 .agents/skills/verify-stremlist/tests/run-check.py` from a fresh checkout. The committed harness and its fixtures need Python 3 and the helper's Linux tools. They start only owned processes and loopback listeners. No Bun installation, Codex skill directory, application stack, or credentials are required.

The suite checks exit codes, timeouts, signals, forced termination, locale preservation, orphaned and detached listeners, occupied ports, invalid arguments, evidence preservation, and local Markdown links. Each invocation writes a unique folder under `test-results/verify-stremlist-helper/`, including `REPORT.md`, `results.json`, and raw process and listener evidence. These outputs stay ignored; the harness stays tracked. A passing expected `BLOCKED` case verifies the helper's verdict, not application teardown.

## User path matrix

Levels: **U** unit (Vitest or SQL), **T** toolkit replay, **P** Playwright `@local` (real backend and database, fixture or real IMDb transport), **L** live (`@live-smoke` or `@live-regression`, public IMDb or hosted Stremio Web). Spec files are in `apps/e2e/tests`, journeys in `apps/e2e/toolkit`. A gap names the level that is missing.

| User path                                                     | Covered by                                                                                                                              | Levels  | Gap                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------- |
| Home: IMDb link to a saved Account                            | `home-onboarding` "new user gets install actions after live validation"; `ui` "Home detects the Provider of a link…"                    | T, L    |                              |
| Home: Trakt, JustWatch, SensCritique, Letterboxd link         | `provider-stremio` "a {provider} link pasted on Home is saved and served to Stremio"; `providers` "pasted links of every…" (Configure)  | T, P    | Real Provider data           |
| Home: link that needs a Connection                            | `providers` "a link that needs a Connection saves the setup, connects…"; `provider-connections`                                         | T, P    | Live OAuth consent           |
| Home: empty setup, Addon URL, invalid input, `?userId`        | `home` "the Home field starts an empty setup…", "Open it refuses…"; `home-onboarding` garbage, unknown, Legacy; `ui` old `?userId` link | T, P, L |                              |
| Configure: add link, Quick add, remove                        | `configure-page` add, chart, remove; `providers` Quick add; `ui` "built-in charts avoid duplicates…"                                    | T, P, L |                              |
| Configure: title, sort, Show, filters, presets, reorder, RPDB | `configure-page`; `configuration-transitions`; `catalog-features`; `ui` List edits, reorder, filters, RPDB                              | T, P    |                              |
| Configure: Merged Lists                                       | `merged-lists` (spec and journey)                                                                                                       | U, T, P | Stremio Web rendering        |
| Configure: New titles                                         | `new-titles` (spec and journey)                                                                                                         | U, T, P |                              |
| Configure: Actions settings and Action pages                  | `providers` "Actions settings save…"; `provider-actions`                                                                                | U, T, P | Real Provider writes         |
| Save, failed save, reload, concurrent edits                   | `ui` save errors, edits while saving; `configuration-recovery`; `merged-lists` other window; reload in most specs                       | T, P    |                              |
| Install: Addon URL, copy, clipboard denial, Stremio Web link  | `configure-page` copy and denial; `stremio-install`                                                                                     | T, P, L | Desktop `stremio://`         |
| Stremio: IMDb manifest, Catalogs, meta, search, pages         | `addon-api`; `catalog-features`; `stremio-catalogs`; `stremio-meta`                                                                     | U, P, L |                              |
| Stremio: other Providers' manifest, Catalogs, meta, streams   | `provider-stremio` "Stremio reads the Catalogs, meta and streams…"; `provider-links`                                                    | P       | Real Provider data           |
| Stremio Web: other Providers' Catalogs                        | `provider-stremio` "Stremio Web shows the Catalogs of every Provider" (fixture backend)                                                 | L       | Real Provider data           |
| Stremio: streams that open Actions                            | `provider-actions`                                                                                                                      | U, P    | Stremio apps                 |
| Catalog preview                                               | `catalog-preview` (spec and journey)                                                                                                    | U, T, P |                              |
| Refresh, sync status, Connection renewal                      | `sync-status`; `provider-sync-status`; `refresh-recovery`; `save-refresh`                                                               | U, T, P |                              |
| Letterboxd queue                                              | `letterboxd-queue`; backend queue tests; `letterboxd_queue.sql`                                                                         | U, T    | Playwright                   |
| Newsletter                                                    | `ui` newsletter; `account-newsletter`; `provider-contract` newsletter                                                                   | T, P    | Email delivery               |
| Terms, Changelog, unknown routes                              | `home` "Terms and Changelog link…"; `ui` public pages; `home-onboarding` unknown routes                                                 | T, P    |                              |
| Errors and recovery                                           | `configuration-recovery`; `ui` load retry, missing Accounts; `configure-page` failed loads; `catalog-preview` Try again                 | T, P    |                              |
| Phone width (390 x 844)                                       | `phone-journey` "on a phone, a link pasted on Home…"; `phone` "on a phone, Home adds a List…"                                           | T, P    | Real phones, Safari          |
| Legacy v1 installs                                            | `addon-api` bootstrap; `stremio-install` Legacy; `sync-status`; `new-titles`; `provider-connections` Legacy; `ui` `?userId`             | T, P, L |                              |
| Kill switch                                                   | `provider-actions` kill switch; `providers` "a Provider turned off…"; `provider-connections` turned off                                 | T, P    |                              |
| Playback, RPDB poster delivery                                | `addon-api` "RPDB key rewrites posters" (URL only)                                                                                      | L       | Playback, authenticated RPDB |

## Coverage gaps

- **UI replay has no persistent backend.** It proves browser state and requests. Use integration specs for saved data, atomicity, cache invalidation, and manifests.
- **Live Provider authorization is unverified by fixtures.** Consent screens, real token issuance, revoked live credentials, and real Provider writes need a disposable authorized account when those integrations change.
- **Newsletter delivery is unverified.** UI tests intercept subscribe requests and integration boot uses a dummy Resend key. Neither proves receipt of email.
- **Other Providers have no live data.** Trakt, Simkl, MDBList, JustWatch, SensCritique, and Letterboxd reach Stremio only through `helpers/provider-fixtures.ts`. A change in a real Provider response is not detected.
- **Real RPDB delivery, playback, and desktop Stremio protocol handling are outside automated E2E coverage.** Verify the affected path separately before claiming it works.
- **Browser coverage is Chromium.** The Playwright projects use Desktop Chrome. There is no configured Firefox or WebKit project, dedicated mobile project, accessibility audit, or screenshot regression suite. `phone-journey.spec.ts` and `toolkit/phone.e2e.ts` run one journey at 390 x 844 in Chromium. Other journeys and real phone browsers stay unverified at phone width.
- **No coverage percentage gate is configured.** Vitest has no coverage threshold in the backend config, and frontend unit tests target scripts and extracted logic. Passing tests do not establish complete component or route coverage.
- **Stress is opt-in.** Normal backend tests exclude `*.stress.test.ts`. CI does not run the load runner.
- **Live dependencies can fail independently of the change.** Record public IMDb and hosted Stremio failures separately. Do not relabel them as passes based on controlled fixtures.
- **The local project is not fully offline.** Saving a chart in `configure-page.spec.ts` starts real IMDb prewarming on the main backend. The tag alone does not establish transport isolation. Provider fixture specs use explicit intercepted transports.
- **Inherited environment matters.** The main Playwright backend inherits exported Provider credentials. Clear them and all Supabase and R2 target overrides as described in Launch. Prevent E2E dotenv files from restoring overrides. The resolved-target check prints only service URLs and the test bucket name.
- **CI scope differs by event.** The Database and E2E jobs run on pull requests and workflow dispatch, not normal branch pushes. A branch push alone is incomplete release evidence.
- **Isolation is fixed.** Toolkit ports, integration ports, the Supabase project ID, and destructive cleanup are shared within a host. Serial workers do not isolate two independent runs.
- **Process groups do not contain detached runner children.** Both runners detach servers or browsers. The helper gates the selected server ports but cannot prove detached-browser teardown. Require a separate ownership and exit check. Timeout, interruption, or forced termination leaves runner teardown unverified. Playwright spec cleanup does not run through this helper's SIGTERM path. Discard the disposable integration stack after an interrupted run.

## Delivery criteria

1. Run the CI baseline for code changes. For documentation-only changes, validate the skill, resolve its links, and execute its launch, doctor, one mapped feature, and cleanup once.
2. Select every affected user entry point from the feature map. Reproduce a reported defect before changing it. Show the user action and the resulting visible state. For a save or Action, include an independent read of the stored result or controlled outbound receipt.
3. Require the strict toolkit replay for UI behavior changes. Require the relevant Playwright specs for backend, storage, Provider, or addon behavior. Identify which specs use fixture transports and which still read IMDb. A toolkit-only pass cannot close a persistence change.
4. For database migrations or write changes, start a fresh disposable stack, apply migrations through Supabase startup, run the relevant SQL checks, and verify the real API behavior afterward.
5. For manifest or Catalog changes, inspect the resulting addon response and run the relevant Stremio installation or Catalog journeys. Confirm whether existing installs require a reinstall. Keep Account URLs private.
6. For visual changes, follow the installed `before-and-after` skill and capture the affected view at relevant desktop and mobile widths with `~/.local/bin/agent-browser`. This verification setup itself changes no product visuals.
7. For external-service changes, state whether evidence uses a live service or the existing fixture boundary. Document missing live coverage and failed prerequisites with the exact command and error.
8. Preserve reports, traces, logs, exit codes, revision, feature IDs, and any skipped entry points in the run's evidence directory. Confirm cleanup removed only run-owned processes and scratch state while keeping evidence.
9. Report every required check as passed, failed, blocked, or not run. An unresolved failure or a required blocked check prevents a verified delivery claim. Identify the missing evidence without weakening the journey.

## Documentation sources

- Local scripts and configuration are authoritative for the pinned tools. The inventory comes from root and workspace `package.json`, `turbo.json`, `.github/workflows/ci.yml`, `apps/e2e/README.md`, and the existing specs.
- [Playwright trace documentation](https://github.com/microsoft/playwright/blob/main/docs/src/trace-viewer-intro-js.md) confirms that `--trace on` preserves successful journeys. This was fetched through Context7 while authoring the skill.

## Recorded verification on 2026-10-16

Initial execution and two parallel agents were blocked by host memory pressure. An expired native TypeScript check from a Wondday worktree consumed nearly the whole shared T3 agent memory allowance. The shared `memory.high` limit throttled unrelated native commands. After the exact expired compiler was stopped, the curl probe changed from timeout to exit 0, and agent-browser, Docker, and dependency installation answered again. A fresh checkout installed all 505 packages with the same Bun 1.4.3 that had stalled earlier.

The initial parallel audit found four instruction defects. The corrected skill clears target overrides and inherited Provider clients, supervises recorded process groups, and describes real IMDb reads accurately. A fresh independent correction audit passed. The supervisor passed five real checks covering success, failure, timeout, interruption, and an orphaned dynamic listener.

The skill was then executed successfully with project-pinned Bun 1.4.0. Frozen installation, browser setup, Doctor, full UI replay, evidence capture, and cleanup passed. The replay ran all 109 tests in 11 files with no failures, skips, interruptions, or model calls. All 21 committed recordings were used and the cache checker returned OK. This proves the mapped UI journeys with intercepted API responses.

The forced lint/build/test/typecheck batch passed all 13 tasks with `--concurrency=1`. It included 1,048 non-browser tests across backend, shared, and frontend scripts. Supabase/S3 integration and live external-service journeys were not run. Their coverage gaps above remain open.

The PR review corrected detached-server detection, shutdown grace, timeout and signal evidence, and child locale preservation. Both independent reviewers reported no remaining actionable findings. The final helper passed 36 checks, including SIGHUP, forced termination, occupied and detached listeners, and locale passthrough. Expected blocked cleanup in interruption tests is not proof of application teardown. These reports and the rerunnable helper harness are under `test-results/pstack-pr-20261016/`.

Initial evidence is under `test-results/pstack-setup-20261016/`. Parallel audit and supervisor evidence is under `test-results/pstack-parallel-20261016/`. Successful execution, raw memory snapshots, reports, and cleanup records are under `test-results/pstack-host-recovery-20261016/`. Temporary verification worktrees were removed and proof files survived cleanup.

The [kernel cgroup documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html), fetched through Context7, explains `memory.high` throttling and the hierarchical event counters used in the diagnosis.
