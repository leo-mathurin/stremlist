# tester-army/e2e coverage

Run from the repository root with Bun:

```sh
bun install --frozen-lockfile
bun run test:toolkit
```

The suite uses `e2e@0.17.0` and `@e2e-dev/web@0.12.0`, with no AI model or
subscription. The runner starts the frontend on `127.0.0.1:4311`. Tests fulfill
API requests to `127.0.0.1:4314`; no database, email service, or account is
modified. No server needs to listen on 4314. The existing Playwright integration
suite remains available through `test:e2e`.

Reports: `apps/e2e/.e2e/report.json`, `summary.md`, `junit.xml`. Failure traces
and screenshots are in `.e2e/artifacts`. These files are ignored by Git.

## Covered flows

| Flow                                                  | Validation                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Home, terms, changelog, unknown route and return home | Rendered headings and navigation                                                            |
| Onboarding                                            | Input format, clearing, profile URL, canonical ID, install URLs, returning user             |
| Validation errors                                     | Private watchlist, unknown ID, network failure, HTTP configuration failure                  |
| Configuration loading                                 | Existing user, missing user, failed load, retry                                             |
| Catalog management                                    | Add/remove, last-row protection, duplicate source rejection, titles, save payload positions |
| Pointer reorder                                       | Drag second catalog before first, visible title order, saved API positions                  |
| Built-in charts                                       | Add chart, prevent duplicate chart, ten-catalog limit                                       |
| Saving                                                | Error preserves changes, retry, reinstall notice, unchanged repeat save                     |
| Refresh                                               | Partial failure, successful refresh, cooldown prevents repeat                               |
| RPDB                                                  | Show/hide key                                                                               |
| Clipboard                                             | Denial provides manual-copy fallback                                                        |
| Newsletter                                            | Email validation, isolated success, server rejection, network failure; no emails sent       |

The existing integration suite additionally verifies real config persistence,
all sort options, content filters, RPDB key save/clear, manifests, catalogs,
metadata, R2 generations/tombstones, refresh throttling, and hosted Stremio
installation/uninstallation, Discover, Board, and item details.

## Verification on 2026-10-05

- Toolkit: 20 passed.
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
  -e MINIO_ROOT_USER=stremlist-e2e \
  -e MINIO_ROOT_PASSWORD=stremlist-e2e-secret \
  minio/minio:latest server /data
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
