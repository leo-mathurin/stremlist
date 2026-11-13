# End-to-end tests

Two suites cover the frontend and addon:

- **Toolkit:** browser journeys with intercepted API responses, plus recorded AI
  actions replayed without credentials in CI. No database is needed.
- **Playwright:** real backend, Supabase and S3-compatible storage, with controlled
  Provider fixtures or live IMDb and hosted Stremio Web. Runs on ports 7301/7302.

## Toolkit

From the repository root:

```sh
bun run test:toolkit:replay

# One-time login, then record changed AI goals locally
bun run --cwd apps/e2e e2e login openai --device
bun run test:toolkit:record
# Or use the workstation's subscription session:
e2e-chatgpt-session bun run test:toolkit:record
```

The toolkit starts Vite on `127.0.0.1:4311`; requests to `127.0.0.1:4314`
are intercepted. Configuration lives in `e2e.config.ts`, journeys in `toolkit/`,
and shared routes/fixtures in `toolkit/config-fixture.ts`. Interception verifies
UI behavior and requests; Playwright verifies handlers and storage.

### Cache rules

- Commit assertion-verified `.e2e/cache/*.json` recordings with the UI/test change;
  never edit recordings by hand. Reports, traces and screenshots stay ignored.
- Renaming tests, changing goals/params, app identity, URL or ports, or upgrading
  the pinned `e2e` / `@e2e-dev/web` versions requires new recordings. Changed
  accessible names can make an existing recording stale too.
- Run recording twice to verify the second pass makes zero model calls, then
  run `bun run test:toolkit:replay`. CI uses this same strict, read-only replay
  and refuses model calls, new recordings and stale/missing cache entries.
- `bun run --cwd apps/e2e test:toolkit:check` checks the last report and recordings;
  add `--prune` after a full replay to delete orphaned entries.
- AI goals use unique accessible names. Configure-page goals call
  `fitConfigurePage` to avoid duplicate Save controls. Toast checks use
  `holdToasts`; it hides the document and suppresses sync-status polling.

## Running locally

Playwright requires Docker, the Supabase CLI and these disposable services:

```sh
supabase start -x gotrue,realtime,storage-api,imgproxy,studio,edge-runtime,logflare,vector,supavisor,mailpit,postgres-meta

docker run --rm -d --name stremlist-e2e-r2 \
  -p 127.0.0.1:7431:9000 \
  -e RUSTFS_ACCESS_KEY=stremlist-e2e \
  -e RUSTFS_SECRET_KEY=stremlist-e2e-secret \
  rustfs/rustfs:1.0.1 /data

bun run test:e2e
bun run --filter @stremlist/e2e test:e2e --project=local
bun run --filter @stremlist/e2e test:e2e --project=live-smoke
bun run --filter @stremlist/e2e test:e2e --project=live-regression
```

Tests delete fixture Legacy alias Accounts and Accounts created since the run
started, their R2 caches/Connection objects and dependent database rows. Use a
separate disposable stack, never a shared development database. Non-loopback
Supabase URLs are rejected unless explicitly enabled below.

## Environment

| Variable                                                       | Purpose                                                          |
| -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `E2E_SUPABASE_URL` / `E2E_SUPABASE_SERVICE_ROLE_KEY`           | Override local database                                          |
| `E2E_R2_ENDPOINT` / `E2E_R2_BUCKET`                            | Override disposable S3 store                                     |
| `E2E_R2_ACCESS_KEY_ID` / `E2E_R2_SECRET_ACCESS_KEY`            | Local S3 credentials                                             |
| `E2E_ALLOW_REMOTE_DATABASE=I_UNDERSTAND_THIS_WIPES_DATA`       | Allow an isolated remote test database; cleanup deletes Accounts |
| `E2E_IMDB_USER_ID` / `E2E_IMDB_USER_ID_2` / `E2E_IMDB_LIST_ID` | Public live fixtures                                             |
| `E2E_PRIVATE_IMDB_USER_ID` / `E2E_PRIVATE_IMDB_LIST_ID`        | Private fixtures (the list ID enables the private-list case)     |

`playwright.config.ts` defines projects; `tests/` contains coverage and assertions.
Provider specs use real adapters with fixture transports and reject unknown
outbound destinations. Live projects depend on IMDb and web.stremio.com. Actual
newsletter delivery, authenticated RPDB delivery, playback and desktop protocol
handling require separate manual verification.
