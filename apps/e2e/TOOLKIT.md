# tester-army/e2e coverage

The toolkit combines real AI-driven browser journeys with exact assertions and
deterministic regression checks. Run from the repository root with Bun:

```sh
bun install --frozen-lockfile
bun run --cwd apps/e2e e2e login openai --device
bun run --cwd apps/e2e e2e models openai
bun run test:toolkit:record
bun run test:toolkit
```

The login command is a one-time local setup for the existing ChatGPT
subscription. The configured `chatgpt(...)` model uses that login. No OpenAI API
key or separately billed API account is required. Each `agent.act` has a model
call limit and a subsequent locator assertion. The configured attempt deadline
is 180 seconds; retries are disabled.

The suite uses `e2e@0.17.0` and `@e2e-dev/web@0.12.0`. The runner starts the
frontend on `127.0.0.1:4311`. Tests fulfill
API requests to `127.0.0.1:4314`; no database, email service, or account is
modified. No server needs to listen on 4314. The existing Playwright integration
suite remains available through `test:e2e`.

Reports: `apps/e2e/.e2e/report.json`, `summary.md`, `junit.xml`. Failure traces
and screenshots are in `.e2e/artifacts`. These files are ignored by Git. Verified
action recordings in `apps/e2e/.e2e/cache/` are committed test fixtures. Do not
edit those recordings by hand.

## AI journeys and credential-free replay

Nine bounded AI goals cover seven existing tests: canonical IMDb onboarding,
returning-user navigation, a built-in catalog, newsletter subscription, RPDB
visibility, clipboard feedback, and saving/clearing filters with a preset.
Assertions still check exact links, page state, filter values, and submitted
payloads. The AI chooses how to complete the goal; it does not decide whether
the test passed. Delayed-save gates, pointer movement, error responses, and
other precise regression mechanics remain deterministic.

Local cache misses use the subscription and record only assertion-verified
actions. To prove that the committed recordings replay without credentials:

```sh
bun run test:toolkit:replay
```

The replay script sets `CI=1` and `E2E_OAUTH_CREDENTIALS='{}'`, so its strict
read-only behavior also applies outside a CI runner. CI runs that same script.
It does not read the local OAuth file, call a model, update recordings, retry,
or skip AI tests. Stale entries fail with `REPLAY_STALE`. A new/unrecorded goal
cannot authenticate and fails instead of silently running live. No subscription
token is exported to CI or stored in the repository.

After changing an AI goal or its UI, run `bun run test:toolkit:record` locally
without `CI` to record its verified actions, then repeat the replay command
and commit the changed cache entries. Inspect entries before committing: they
contain actions and synthetic values, not screenshots or conversations. A
`--no-cache` run tests live AI behavior but does not write recordings.

## AI/cache verification on 2026-10-05

The cold run used the existing ChatGPT subscription with `gpt-6-luna`: all seven
agent journeys passed, making 27 real model calls and recording nine verified
action sequences. It used 137,028 tokens. The provider's prompt-cache discount
is separate from action replay.

The subsequent full replay passed all 27 tests with nine recorded steps replayed,
zero model calls, zero model tokens, zero retries, and zero skipped tests.
It used `test:toolkit:replay`, which explicitly supplies an empty credential map.
A separate run before recording proved that a missing cache entry fails instead
of skipping the AI journey or using a local login.

Reports for these runs are local and ignored: `.e2e/cold/report.json` and
`.e2e/replay/report.json` (each also has `summary.md`). The nine committed JSON
recordings total about 18 KiB and contain only synthetic fixture data. Frozen
Bun installation, E2E lint, and E2E typecheck passed.

## Covered flows

| Flow                                                  | Validation                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Home, terms, changelog, unknown route and return home | Rendered headings and navigation                                                                             |
| Onboarding                                            | Input format, clearing, profile URL, canonical ID, install URLs, returning user                              |
| Validation errors                                     | Private watchlist, unknown ID, network failure, HTTP configuration failure                                   |
| Configuration loading                                 | Existing user, missing user, failed load, retry                                                              |
| Catalog management                                    | Add/remove, last-row protection, duplicate source rejection, titles, save payload positions                  |
| Filters and presets                                   | Save genre and preset settings; clearing filters preserves presets                                           |
| Pointer reorder                                       | Drag second catalog before first, visible title order, saved API positions                                   |
| Built-in charts                                       | Add chart, prevent duplicate chart, ten-catalog limit                                                        |
| Saving                                                | Error preserves changes, retry, reinstall notice, unchanged repeat save, concurrent refresh and filter edits |
| Refresh                                               | Partial failure, successful refresh, cooldown prevents repeat                                                |
| RPDB                                                  | Show/hide key                                                                                                |
| Clipboard                                             | Denial provides manual-copy fallback                                                                         |
| Newsletter                                            | Email validation, isolated success, server rejection, network failure; no emails sent                        |

The existing integration suite additionally verifies real config persistence,
all sort options, content filters, RPDB key save/clear, manifests, catalogs,
metadata, R2 generations/tombstones, refresh throttling, and hosted Stremio
installation/uninstallation, Discover, Board, and item details.

## Verification on 2026-10-05

- Toolkit before staging rebase: 20 passed.
- Existing local integration: 21 passed.
- Existing live smoke/regression: 25 passed, using live IMDb and hosted Stremio.
- Workspace typecheck, lint, and frontend build passed.
- Browser preview inspected with the required agent-browser CLI session.

Integration tests used a separate Supabase project, copied to
`/tmp/stremlist-e2e-20261005`, with `project_id = "stremlist-agent-e2e-20261005"`
and all 543xx ports replaced by 553xx. Migrations were applied by `supabase start`.
The existing Wondday stack on 54321 was not used. MinIO ran in the dedicated
`stremlist-agent-e2e-r2-20261005` container on port 7531. Its disposable credentials
are the existing public E2E defaults in `env.ts`. The documented Quay image
returned HTTP 401; the Docker Hub `minio/minio:latest` image started successfully.

The task services are now stopped. The temporary Supabase work directory was
removed during cleanup. From the repository root, restart isolated services
without touching the existing development stack:

```sh
python3 - <<'PY'
from pathlib import Path
import shutil
root = Path("/tmp/stremlist-e2e-20261005")
root.mkdir(exist_ok=True)
shutil.copytree("supabase", root / "supabase", dirs_exist_ok=True)
config = root / "supabase/config.toml"
text = config.read_text().replace(
    'project_id = "stremlist"',
    'project_id = "stremlist-agent-e2e-20261005"',
).replace("543", "553")
config.write_text(text)
PY
supabase start --workdir /tmp/stremlist-e2e-20261005 \
  -x gotrue,realtime,storage-api,imgproxy,studio,edge-runtime,logflare,vector,supavisor,mailpit,postgres-meta
# Remove only the stopped test container before recreating it.
docker rm stremlist-agent-e2e-r2-20261005
docker run --rm -d --name stremlist-agent-e2e-r2-20261005 \
  -p 127.0.0.1:7531:9000 \
  -e RUSTFS_ACCESS_KEY=stremlist-e2e \
  -e RUSTFS_SECRET_KEY=stremlist-e2e-secret \
  rustfs/rustfs:1.0.1 /data
```

Then run the real integration suite:

```sh
E2E_SUPABASE_URL=http://127.0.0.1:55321 \
E2E_R2_ENDPOINT=http://127.0.0.1:7531 \
bun run --cwd apps/e2e test:e2e
```

Clean up only these test resources after verification:

```sh
supabase stop --workdir /tmp/stremlist-e2e-20261005 --no-backup
docker stop stremlist-agent-e2e-r2-20261005
```

## Validation after updating from staging

The task branch was rebased on staging commit `c36c1ad`. Staging moved catalog
configuration into `useWatchlistConfiguration`; the save baseline fix now
uses that hook and preserves catalog settings and available genres. The test
servers use staging's `dev:app` Vite script instead of its Portless `dev` script.

Toolkit: 21 passed after the rebase.

Workspace typecheck, lint, build, and tests passed after the rebase (189 backend
tests plus frontend development proxy tests). The toolkit now also checks genre
filters, preset catalogs, clearing filters, and the larger editor's pointer
reordering. The previous 46 real integration checks were run before this rebase;
they were subsequently rerun against the source-built MinIO release during the
CI repair (see below).

A fresh frozen Bun installation in a temporary directory successfully opened
configuration without React deduplication. The existing checkout had frontend
React from old pnpm symlinks and a different React for newly installed Radix
checkboxes, causing an invalid-hook-call crash. Vite deduplicates React and React
DOM to support these mixed-manager checkouts; it is a compatibility guard, not
a requirement demonstrated by the clean Bun dependency tree.

## Defects fixed

A failed configuration lookup previously counted as an existing user and
showed install/configuration actions. Only a successful response now identifies
a returning user; HTTP/network errors show validation failure.

A newly saved catalog receives a server ID. The old save baseline retained
its temporary ID, so the next unchanged save incorrectly requested a reinstall.
The baseline now uses the saved rows. Both defects have regression tests that
failed before the fixes and passed after them.

The onboarding regression uses endpoint-specific responses: configuration GET
returns 503 while validation is available with a valid response. Both typed-ID
and initial-query entry are tested. The app checks configuration first, so the
test asserts that configuration was requested and validation was not requested
after the error. Neither installation actions nor a returning-user welcome may
appear. Typed-ID failure must also leave the home URL without a userId parameter.

## Limits

The deterministic suite checks frontend behavior against API fixtures. It does
not prove delivery of real newsletter email or external RPDB poster availability.
A private IMDb `ls` list is not verified.
The app has no account sign-in; IMDb ID resolution and anonymous Stremio
installation are the relevant identity flows. Hosted Stremio and live IMDb tests
need network access and can change when those services change.

## CI infrastructure repair

CI now uses Bun 1.4.0 and `bun ci` (a frozen install), matching the committed
workspace lockfile. Its regular lint/build/test and integration gates remain
active, and the tester-army suite is also run in CI.

Both official MinIO image registries now reject anonymous pulls for the existing
release, including the immutable digest. The prior local tests used a cached
image. Before the later staging merge, CI and local instructions built the exact official source release
`RELEASE.2025-09-07T16-13-09Z`, commit
`07c3a429bfed433e49018cb0f78a52145d4bedeb`. The source archive checksum is checked
in the Dockerfile; Go 1.24.6 builds the unchanged source. No third-party mirror
or different MinIO release is used.

A delayed-save regression reproduced the review finding that later edits were
lost when a response arrived. Response handling now merges saved IDs by local
row ID into the current rows and retains edits, new rows, removed rows, and
reordered rows. Only the submitted snapshot becomes the saved baseline. If the
form changed during the request, the UI explicitly reports unsaved changes.
Delayed-save tests cover edits/additions, removal, and reordering, including the
payload sent by the next save.

Final CI-repair validation: frozen Bun install passed; lint/build/test passed
(189 backend and 3 frontend tests); all 25 toolkit tests passed; atomic SQL
configuration replacement passed; all 53 current local/live integration tests
passed with the pinned source-built MinIO container and isolated Supabase stack.
The source build reports the expected release and commit. Test services were
stopped after this validation.

The newer React Hooks lint rule in a fresh Bun dependency tree rejected the
inherited synchronous reset effect. Configuration content now remounts when its
IMDb account changes; its state initializes for that account, and retries set
loading state in the retry action. The fetch effect updates state only from the
asynchronous response. Fresh frozen-dependency lint/build/test checks passed
without suppressing the rule. The toolkit also covers selecting an account from
the configuration entry form, and the delayed edit/addition test verifies the
next save payload including a synthetic RPDB key changed during the request.

Save feedback reads the committed form snapshot synchronized in a layout effect.
CI traces showed a separate test timing error: dnd-kit optimistically reordered
DOM nodes before React committed their new indices. The response was released
26 ms after reading the moved title. The delayed reorder test now also waits for
the moved rows to receive their React-rendered Catalog 1 / Catalog 2 labels before
releasing the response. It retains the unsaved warning and next-save position
assertions; no fixed delay or retry was added.

The committed-row reorder check passed in all 25 toolkit tests on both macOS
and isolated Linux arm64 (Node 24, Bun 1.4.0, Chromium 153). The Linux run used
a frozen Bun install and the same framework browser dependency installer as CI.

## Merge of the Bun migration

Staging `9650b9d` introduced Bun workspace metadata, backend Bun runtime and smoke
gates, isolated backend environment loading, and RustFS 1.0.1 for S3 tests. These
upstream changes are retained. The earlier MinIO source-build Dockerfile is
removed because RustFS replaces that infrastructure. Toolkit CI execution and
reports remain enabled. The restart commands above now use RustFS.

After this merge, a fresh `bun ci` tree passed all 8 lint/build/test tasks and all
25 toolkit tests. Frontend/E2E typechecks, the backend Bun bundle smoke, and the
atomic configuration SQL check passed. All 53 real local/live integration tests
passed with isolated Supabase and RustFS 1.0.1. Test services were then stopped.

## Save and refresh concurrency regression

The toolkit now has 27 tests. Two new cases hold a save response while refresh
updates the available genres. Refresh metadata alone must not produce an unsaved
changes warning. A genre filter selected during the same request must still
produce that warning and appear in the next save payload. Both cases wait for
the refreshed genre control to become enabled before releasing the save response.

The metadata-only case failed before the fix. Save requests and dirty checks now
use the same editable configuration projection, excluding server metadata.
All 27 toolkit tests passed after the fix. These are intercepted frontend checks;
they do not extend real backend or external-service coverage.
