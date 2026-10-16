# Coverage and delivery criteria

## Existing checks

The commands below reuse the repository's runners. Read installed Turborepo docs before changing task commands or configuration, as required by `AGENTS.md`.

| Check              | Command                                                                                         | What it proves                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| CI baseline        | `bunx turbo run lint build test --force`                                                        | ESLint, production builds, backend Vitest, frontend Node and Bun script tests, and shared Vitest tests execute without cached results.       |
| Workspace types    | `bun run typecheck --force`                                                                     | Backend, stress tools, frontend, shared, and E2E TypeScript checks. CI does not run this separate root task.                                 |
| UI journeys        | `bun run test:toolkit:replay`                                                                   | Real frontend interactions, exact HTTP payloads, errors, and replayed actions with zero model calls.                                         |
| Local integration  | `CI=1 bun run --filter @stremlist/e2e test:e2e --project=local --trace on`                      | Real handlers, database, and caches. Provider fixture specs control external transports, but some other local specs trigger real IMDb reads. |
| Live compatibility | Run the same E2E command separately with `--project=live-smoke` and `--project=live-regression` | Public IMDb behavior and hosted Stremio Web compatibility for tagged tests.                                                                  |
| Atomic SQL writes  | Commands below                                                                                  | Transaction and concurrency invariants in real Postgres.                                                                                     |
| Scraper stress     | `bun run --cwd apps/backend test:stress`                                                        | The existing scraper stress cases, excluded from normal backend tests.                                                                       |
| Formatting         | Use the installed Prettier on changed supported files, or `bun run format:check`                | Formatting only. No behavior proof. Shared has no `format:check` script.                                                                     |

Run SQL checks only inside the disposable stack started for this run.

```sh
docker exec -i supabase_db_stremlist psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/replace_account_config.sql
docker exec -i supabase_db_stremlist psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/record_list_refresh.sql
docker exec -i supabase_db_stremlist psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/account_writes.sql
```

For cache, scraper, and throughput changes, consult `apps/backend/stress/README.md` and use its existing load runner. Load tests are not part of a routine documentation change. `bun run knip` exists for unused-code analysis but is not a CI delivery gate.

## Command supervisor checks

Run `python3 .agents/skills/verify-stremlist/tests/run-check.py` from a fresh checkout. The committed harness and its fixtures need Python 3 and the helper's Linux tools. They start only owned processes and loopback listeners. No Bun installation, Codex skill directory, application stack, or credentials are required.

The suite checks exit codes, timeouts, signals, forced termination, locale preservation, orphaned and detached listeners, occupied ports, invalid arguments, evidence preservation, and local Markdown links. Each invocation writes a unique folder under `test-results/verify-stremlist-helper/`, including `REPORT.md`, `results.json`, and raw process and listener evidence. These outputs stay ignored; the harness stays tracked. A passing expected `BLOCKED` case verifies the helper's verdict, not application teardown.

## Coverage gaps

- **UI replay has no persistent backend.** It proves browser state and requests. Use integration specs for saved data, atomicity, cache invalidation, and manifests.
- **Live Provider authorization is unverified by fixtures.** Consent screens, real token issuance, revoked live credentials, and real Provider writes need a disposable authorized account when those integrations change.
- **Newsletter delivery is unverified.** UI tests intercept subscribe requests and integration boot uses a dummy Resend key. Neither proves receipt of email.
- **Real RPDB delivery, playback, and desktop Stremio protocol handling are outside automated E2E coverage.** Verify the affected path separately before claiming it works.
- **Browser coverage is Chromium.** The Playwright projects use Desktop Chrome. There is no configured Firefox or WebKit project, dedicated mobile project, accessibility audit, or screenshot regression suite. Viewport changes in UI specs do not establish full mobile coverage.
- **No coverage percentage gate is configured.** Vitest has no coverage threshold in the backend config, and frontend unit tests target scripts and extracted logic. Passing tests do not establish complete component or route coverage.
- **Stress is opt-in.** Normal backend tests exclude `*.stress.test.ts`. CI does not run the load runner.
- **Live dependencies can fail independently of the change.** Record public IMDb and hosted Stremio failures separately. Do not relabel them as passes based on controlled fixtures.
- **The local project is not fully offline.** Saving a chart in `configure-page.spec.ts` starts real IMDb prewarming on the main backend. The tag alone does not establish transport isolation. Provider fixture specs use explicit intercepted transports.
- **Inherited environment matters.** The main Playwright backend inherits exported Provider credentials. Clear them and all Supabase and R2 target overrides as described in Launch. Prevent E2E dotenv files from restoring overrides. The resolved-target check prints only service URLs and the test bucket name.
- **CI scope differs by event.** The E2E job runs on pull requests and workflow dispatch, not normal branch pushes. The lint/build/test job omits the standalone root typecheck and format check. A branch push alone is incomplete release evidence.
- **Isolation is fixed.** Toolkit ports, integration ports, the Supabase project ID, and destructive cleanup are shared within a host. Serial workers do not isolate two independent runs.
- **Process groups do not contain detached runner children.** Both runners detach servers or browsers. The helper gates the selected server ports but cannot prove detached-browser teardown. Require a separate ownership and exit check. Timeout, interruption, or forced termination leaves runner teardown unverified. Playwright spec cleanup does not run through this helper's SIGTERM path. Discard the disposable integration stack after an interrupted run.

## Delivery criteria

1. Run the CI baseline for code changes. Run workspace typechecks when types or consuming interfaces change. For documentation-only changes, validate the skill, resolve its links, and execute its launch, doctor, one mapped feature, and cleanup once.
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
