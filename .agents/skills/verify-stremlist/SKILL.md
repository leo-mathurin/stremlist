---
name: verify-stremlist
description: Verify Stremlist's configuration web UI and Stremio addon API with the existing toolkit replay, Playwright, unit tests, and SQL checks. Use before handing off behavior changes or checking a release.
---

# Verify Stremlist

Read the [feature map](features/README.md), then select the affected journeys. Read [coverage and delivery criteria](references/coverage.md) before reporting completion. Run commands from the repository root unless a command sets another directory.

## Launch

Use Node 24, Bun from `package.json`, and the committed lockfile. This checkout uses React and Vite, a Bun and Hono backend, Supabase, and S3-compatible caches. The primary user path is the web configuration page. Stremio reads the addon API.

```sh
bun install --frozen-lockfile
bun run --cwd apps/e2e e2e-web install chromium
```

Choose one mode. Never run both modes or two copies of a mode against shared state.

- **UI replay** needs no database, Provider credentials, or model login. `bun run test:toolkit:replay` launches Vite on `127.0.0.1:4311`. Each test seeds its own API responses at the existing HTTP boundary, `127.0.0.1:4314`. Nothing listens on 4314. A test's first visible-state assertion proves readiness and fixture loading. Browser contexts and the frontend stop when the runner exits.
- **Integration** uses the real backend, database, and S3-compatible store. Follow [the E2E setup](../../../apps/e2e/README.md). On a host reserved for this run, start the stack below. Supabase applies `supabase/migrations` to a fresh database. Require successful startup, then run preflight. Tests seed their own data. Playwright owns backend port 7301 and frontend port 7302.

Before integration setup, use a shell with no E2E dotenv files in `apps/e2e`. Clear inherited target overrides and disable Provider clients on the main backend. Keep this environment for preflight and every integration command. Reapply the block in each fresh terminal or tool call, as exports from an earlier shell do not persist.

```sh
unset E2E_SUPABASE_URL E2E_SUPABASE_SERVICE_ROLE_KEY E2E_ALLOW_REMOTE_DATABASE
unset E2E_R2_ENDPOINT E2E_R2_BUCKET E2E_R2_ACCESS_KEY_ID E2E_R2_SECRET_ACCESS_KEY
export TRAKT_CLIENT_ID= TRAKT_CLIENT_SECRET= SIMKL_CLIENT_ID= SIMKL_CLIENT_SECRET=
export MDBLIST_CLIENT_ID= MDBLIST_CLIENT_SECRET= TMDB_API_KEY=
bun --no-env-file --eval '
	const c = await import("./apps/e2e/env.ts");
	if (c.SUPABASE_URL !== "http://127.0.0.1:54321" || c.R2_ENDPOINT !== "http://127.0.0.1:7431" || c.R2_BUCKET !== "stremlist-e2e-cache") throw new Error("Unexpected integration target");
	console.log({supabase: c.SUPABASE_URL, storage: c.R2_ENDPOINT, bucket: c.R2_BUCKET});
'
```

The target check precedes setup so preflight cannot create a bucket on an inherited remote endpoint. The preflight reads `accounts` and creates the test bucket if absent. It is setup, not a read-only doctor. The integration configuration supplies dummy newsletter credentials and prevents loading the backend `.env`. It still inherits exported variables, which the environment block clears or disables. Provider fixture backends explicitly supply their own dummy OAuth clients.

The integration cleanup deletes fixture Accounts and every Account created since the run began, with their dependent rows and cache objects. Loopback alone does not prove isolation. Reserve the Supabase project `stremlist` and ports 54320, 54321, 54322, 7301, 7302, and 7431. Refuse a shared development database. Keep all target overrides cleared. If any reserved service already exists, use UI replay or report the isolation blocker. Separate worktrees do not isolate these host resources.

After Doctor confirms the reserved ports are free and the target check passes, start the disposable stack.

```sh
supabase start -x gotrue,realtime,storage-api,imgproxy,studio,edge-runtime,logflare,vector,supavisor,mailpit,postgres-meta
docker run --rm -d --name stremlist-e2e-r2 \
	-p 127.0.0.1:7431:9000 \
	-e RUSTFS_ACCESS_KEY=stremlist-e2e \
	-e RUSTFS_SECRET_KEY=stremlist-e2e-secret \
	rustfs/rustfs:1.0.1 /data
bun --no-env-file run --cwd apps/e2e playwright install chromium
bun --no-env-file run --cwd apps/e2e preflight.ts
```

## Doctor

Run this read-only check before launch and whenever startup stalls. Save its output with the run's evidence.

```sh
git rev-parse HEAD
node --version
bun --version
ss -ltnp '( sport = :4311 or sport = :4314 or sport = :7301 or sport = :7302 or sport = :7431 or sport = :54320 or sport = :54321 or sport = :54322 )'
```

Before launch, require the selected mode's ports to be free. While running, compare each listener PID and working directory with the process this run started. For UI replay, 4314 must remain unused. For integration, require the disposable containers started by this run. `docker ps` and `docker inspect` can identify them without printing their environment.

Once Vite starts, `curl --fail --max-time 5 http://127.0.0.1:4311/` must return the frontend document. For integration, use port 7302 and require `curl --fail --max-time 5 http://127.0.0.1:7301/health` to succeed. These responses prove liveness only. Require the journey's visible assertions and saved-state reads to prove usability. If a command hangs, preserve its output and report the prerequisite as blocked.

If unrelated tools stall even on `--version`, inspect memory pressure before reinstalling. Follow the current process's cgroup ancestors to the shared finite `memory.high` limit. Read `memory.current`, `memory.events`, and `memory.pressure` there. Compare two samples, as historical event totals alone do not establish active throttling. A sibling task can throttle this run while its own leaf cgroup has no limit. Identify the exact workload and its owner before changing anything. The host recovery is recorded in the [coverage reference](references/coverage.md).

## Drive

Create a unique evidence directory outside the runners' output directories.

```sh
VERIFY_EVIDENCE="$PWD/test-results/pstack-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$VERIFY_EVIDENCE"
git rev-parse HEAD > "$VERIFY_EVIDENCE/revision"
git status --short > "$VERIFY_EVIDENCE/status-before"
```

For UI replay, run the full existing suite through the executable helper. It records a separate process group, command, logs, exit status, and cleanup results. The cache checker compares all recordings with the full report, so a filtered replay is not a substitute.

```sh
.agents/skills/verify-stremlist/scripts/run-check.sh "$VERIFY_EVIDENCE/toolkit-run" 600 4311,4314 \
	bun --no-env-file run test:toolkit:replay
```

Require `toolkit-run/exit` to contain 0, all selected tests passed, and `toolkit cache: OK` in `toolkit-run/stdout.log`. The existing replay wrapper enforces `CI=1`, a read-only strict cache, empty model credentials, and zero model calls. Do not switch to recording to hide a replay failure. Follow the existing E2E README when a UI change genuinely needs new recordings.

For integration, run one mapped feature first, then the affected specs. `CI=1` rejects an occupied frontend or backend port instead of reusing another instance. Traces stay enabled on successful runs too.

```sh
CI=1 .agents/skills/verify-stremlist/scripts/run-check.sh "$VERIFY_EVIDENCE/playwright-run" 600 7301,7302 \
	bun --no-env-file run --filter @stremlist/e2e test:e2e --project=local \
	tests/merged-lists.spec.ts --grep 'merging two Lists on the configure page saves and survives a reload' --trace on
```

The complete local integration pass uses `CI=1 bun run --filter @stremlist/e2e test:e2e --project=local --trace on`, inside the same helper. Local specs include fixture transports and some real IMDb reads, including save-triggered chart prewarming. This project is not an offline suite. Live projects also require public IMDb and hosted Stremio Web. Run `--project=live-smoke` and `--project=live-regression` separately when those paths change. Keep their outcomes separate from fixture-backed specs.

Projects select tags, not whole files. Check the selected tests with the existing Playwright `--list` option when narrowing a run. Zero selected tests is not a pass.

For an interactive preview of an owned running app, use `~/.local/bin/agent-browser`. Set `VERIFY_BROWSER_SESSION="stremlist-verify-$(date -u +%Y%m%dT%H%M%SZ)-$$"`. Read its `--help` with that `--session`, then keep the session on every call. Open the local frontend, run `snapshot -i`, then use snapshot references with `fill` and `click`. Save snapshots and screenshots before and after the action. The toolkit's API interception belongs to its browser context. A separate browser does not inherit its seeded Account or responses.

## Evidence

Save the command, exit code, feature ID, entry point, and observed result for each journey. A successful screenshot alone is insufficient. Keep the action and resulting visible state, plus the existing spec's second read of saved configuration, catalog response, database row, or stored object where relevant. Use existing fixtures only at the HTTP and Provider transport boundaries already defined by the repository.

Copy runner artifacts before another run overwrites them.

```sh
test ! -d apps/e2e/.e2e || cp -R apps/e2e/.e2e "$VERIFY_EVIDENCE/toolkit"
test ! -d apps/e2e/playwright-report || cp -R apps/e2e/playwright-report "$VERIFY_EVIDENCE/playwright-report"
test ! -d apps/e2e/test-results || cp -R apps/e2e/test-results "$VERIFY_EVIDENCE/playwright-results"
```

The toolkit report and recorded steps prove UI requests and responses. They do not prove persistence or Provider authorization. Playwright traces include actions, DOM snapshots, and network exchanges. Keep Account URLs and credentials out of shared artifacts. Use only disposable fixtures in published proofs.

## Cleanup

Let test runners finish normally so their browser, frontend, backend, and fixture teardown runs. The helper terminates its recorded process group and gives it ten seconds to stop before forced termination. This covers a fixture backend whose startup fails before its `stop` callback becomes available. Read `cleanup`, `forced-kill`, and `processes-after-cleanup` in each run directory. Require a passed check, no forced kill, and no live group members.

The helper traps SIGHUP, SIGINT, and SIGTERM and sends SIGTERM to its group. Toolkit supports SIGTERM, but Playwright's graceful spec teardown uses SIGINT. A timeout or a trapped interruption therefore leaves runner teardown unverified, even when the group and ports are empty. The helper reports blocked cleanup for exits 124, 129, 130, 137, and 143. It records forced termination from its own kill, timeout's kill diagnostic, or exit 137. After an interrupted integration run, discard the run-owned disposable database and storage before another run. Do not treat `forced-kill=no` as proof that spec cleanup ran.

Both runners start detached processes. Toolkit Vite and Playwright webServers and Chromium can leave the recorded group. The helper refuses occupied server ports before launch and reports blocked cleanup if the selected ports still listen afterward. Require `server-listeners-after-cleanup` to be empty. `listeners-after-cleanup` also captures dynamic fixture ports. A group pass alone does not prove detached-server or browser teardown. Inspect any remaining run-owned detached browser and verify its exit separately before claiming cleanup. If ownership or exit cannot be established, report cleanup as blocked. Never kill by process name or free a port by killing an unknown owner.

If this run created the disposable RustFS container, stop that exact container with `docker stop stremlist-e2e-r2`. If this run created the reserved Supabase stack, use `supabase stop --no-backup` from the repository root. This discards disposable verification state. Do not stop a pre-existing stack. Stop fixture backends before deleting their temporary directories.

Close an interactive browser with `~/.local/bin/agent-browser --session "$VERIFY_BROWSER_SESSION" close`. Inspect the reserved ports again. Require no listeners owned by this run. Preserve `$VERIFY_EVIDENCE` and confirm its log and exit files still exist after teardown. Record cleanup failures alongside test failures.

## Helpers

Use executable `scripts/run-check.sh NEW_EVIDENCE_DIR TIMEOUT_SECONDS SERVER_PORTS_OR_DASH COMMAND [ARGS...]` for each long-running command. Supply the mode's server ports as a comma-separated list. Use `-` only for commands with no servers. Do not include the disposable database or storage ports, which stay up until container cleanup. The parent evidence directory must already exist. The child directory must be new. The helper uses Bash, `setsid`, GNU `timeout`, `env`, `ps`, and `ss` on this Linux host. A run that detaches into another session needs its own explicit teardown and cannot be claimed covered by group cleanup. For a different host, establish equivalent ownership before driving the app.

Reuse `apps/e2e/toolkit-cache.ts` through `bun run test:toolkit:replay`, `apps/e2e/preflight.ts`, and the existing Playwright config and fixtures. The helper supervises these runners and does not replace them. For implementation checks, SQL commands, and delivery gates, read [coverage and delivery criteria](references/coverage.md).

Keep the feature map current with `/maintain-verification-skill` when user journeys change.
