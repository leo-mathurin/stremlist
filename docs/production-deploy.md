# Production deploy

A merge into `main` is the only action needed to release. The
[`Supabase deploy`](../.github/workflows/supabase-deploy.yml) workflow applies
the database migrations and `supabase/config.toml`, then publishes the backend and the frontend built
from the same commit. Nobody deploys from a laptop, and nobody runs SQL by hand
in the production dashboard.

## Release v2.0.0

PR #74 contains PR #73 (this workflow and the baseline). Merge #74 only. If
#73 is merged first, #74 still merges with no new merge from `main`.

Before you merge, in Vercel, `stremlist-backend`, Production environment.
The deployment reads these values when the workflow builds it:

- [ ] `CONNECTION_ENCRYPTION_KEY`: 32 random bytes in base64
      (`openssl rand -base64 32`). Required: Connections fail without it.
      Never change it later: it decrypts the stored tokens.
- [ ] `TRAKT_CLIENT_ID` (`TRAKT_CLIENT_SECRET` only for a Trakt app created
      before 2026-10-01), `SIMKL_CLIENT_ID`, `SIMKL_CLIENT_SECRET`,
      `MDBLIST_CLIENT_ID`, `MDBLIST_CLIENT_SECRET`.
- [ ] Callback URL `https://api.stremlist.com/oauth/<provider>/callback` is
      registered in the Trakt, Simkl and MDBList apps (`<provider>` is
      `trakt`, `simkl` or `mdblist`).
- [ ] `BACKEND_PUBLIC_URL=https://api.stremlist.com`.
- [ ] `TMDB_READ_ACCESS_TOKEN` (or `TMDB_API_KEY`).
- [ ] `LETTERBOXD_MAX_RPS=40` (the default is 10).
- [ ] `BETTERSTACK_HEARTBEAT_URL_LETTERBOXD`, `_JUSTWATCH`, `_SENSCRITIQUE`,
      and `MONITOR_JUSTWATCH_REF`, `MONITOR_SENSCRITIQUE_REF` (a probe with no
      reference or no heartbeat does not run).

Then:

1. Merge #74. CI puts the `v2.0.0` commit on `main`, then `Supabase deploy`
   releases it. The plan lists 11 migrations and `pg_cron: available`.
2. When the run is green: `https://api.stremlist.com/health` returns
   `"database":"up"`, and an existing `ur…` install still shows its catalogs.
3. In Better Stack, unpause the Letterboxd, JustWatch and SensCritique
   heartbeats.
4. Merge `main` into `staging`, so that staging runs v2.
5. Later, when no v1 deployment uses the database, drop the v1 shape (see
   [After v2.0.0](#after-v200)).

### v1 keeps working during the release

`20261006120000_accounts_providers_connections.sql` renames `users` to
`accounts` and `user_watchlists` to `lists`. The same file creates views named
`users` and `user_watchlists` and the three v1 RPCs (`replace_user_config`,
`request_watchlist_prewarm`, `finish_watchlist_prewarm`) on the new tables. The
v1 backend, and old staging and preview deployments, keep reading and writing
until v2 is promoted. `supabase/tests/v1_compatibility.sql` runs the v1
queries on the new schema, and the CI upgrade test migrates v1 data with
non-`ur` Legacy IDs.

| Failure point                                   | Result                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Plan: production cannot install `pg_cron`       | Nothing changes. The run stops before `db push`.                                           |
| `20261006110000_enable_pg_cron`                 | Nothing changes. pg_cron is installed first, before any table change.                      |
| `20261006120000_accounts_providers_connections` | The file rolls back. Production keeps the v1 schema.                                       |
| A later migration, or `config push`             | The rename and the v1 views stay. v1 keeps serving. Correct the failed file and run again. |
| Publish, before the backend promotion           | v1 keeps serving on the new schema through the views. Run the workflow again.              |
| Publish, after the backend promotion            | v2 serves `api.stremlist.com`. See [When the workflow fails](#when-the-workflow-fails).    |

Previews of v2 branches that are built before the release fail: the
`accounts` table does not exist in production yet.

### After v2.0.0

[`supabase/contract/drop_v1_compatibility.sql`](../supabase/contract/drop_v1_compatibility.sql)
drops the v1 views and RPCs. It is not in `supabase/migrations`, so no deploy
applies it. CI applies it in a rolled-back transaction to prove that it still
runs. When v2 serves production and staging, and no one uses an older
preview, move it to `supabase/migrations/<YYYYMMDDHHMMSS>_drop_v1_compatibility.sql`
in a new PR. Its header lists the other files to delete.

## Sequence

The workflow starts when `CI` passes on the push to `main`. It does not start
when `CI` fails, so a red `main` never reaches production.

1. **Release commit.** The commit to release is the merge commit, or the
   `chore(release): vX.Y.Z [skip ci]` commit that the CI `version-bump` job
   puts on top of it. That commit changes only the version files, so the tested
   code is the released code. Any other commit on `main` means a newer merge
   has overtaken this run: the run stops, and the newer run releases both.
2. **Plan** (read-only) and **Build**, in parallel:
   - Plan compares `supabase/migrations` with
     `supabase_migrations.schema_migrations` in production, through the
     Management API in a read-only transaction. It lists the migrations to
     apply in the run summary. It fails when production has a version that has
     no file in the repo, or a version with a different name. Then it runs
     `supabase db push --dry-run` and `supabase config diff`.
   - Build creates a production deployment of `stremlist-backend` and
     `stremlist-frontend` from the GitHub commit, without custom domains, and
     waits until both are ready. Production still serves the old deployments.
3. **Apply.** Checks again that `main` has not moved, plans again, runs
   `supabase db push --include-all`, checks that the production history
   matches the repo, then runs `supabase config push`.
4. **Publish.** Calls `/health` (which reads the database) and
   `/manifest.json` on the new backend deployment, checks again that `main` has
   not moved, promotes the backend to `api.stremlist.com`, then the frontend to
   `stremlist.com`. It checks that each domain serves the new deployment.

One release runs at a time (`concurrency: production-deploy`), and a running
release is never cancelled.

## Why this order

The backend must not run on a schema that does not have its migrations yet.
Vercel's Git integration builds and publishes `main` on its own, with no wait
for the database, so `vercel.json` turns it off for `main`
(`git.deploymentEnabled.main: false`). The workflow creates the deployments
instead, from the same GitHub commit, and publishes them only after the
migrations. This is the Wondday approach (ADR-0018 there), with one change: the
build runs before the migrations, so the old backend serves the new schema for
seconds (smoke test and promotion), not for the whole build.

That short window still exists. Keep each migration compatible with the
backend that is in production: add first, and remove or rename in a later
release when no deployed code uses the old shape (expand, then contract).

`staging` still deploys through the Git integration. Staging and preview
deployments use the production database (Vercel sets the same `SUPABASE_URL`
for every environment): a staging deployment that
needs a migration breaks until `main` releases that migration, and an old
staging deployment can break after a migration that removes or renames
something.

## Writing a migration

- Add a new file `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`. Never change
  a file that production already applied: the change would not run.
- Check it locally: `supabase start` applies every migration on an empty
  database, and the CI E2E job does the same on each pull request.
- A version older than the latest one in production still applies
  (`--include-all`). The plan marks it; check that its order is correct.
- `CREATE EXTENSION` and `cron.schedule` work in a migration: the push
  connects as `postgres`. The plan blocks the release when production cannot
  install an extension that a pending migration creates. Create an extension
  in its own file, before the migrations that change existing tables.
- Each file is applied in one transaction, with its history row. If a file
  fails, the files before it stay applied, nothing of the failed file stays, and
  nothing is published. Production has not applied the failed file, so correct
  that file itself in a new pull request (a new migration after it would not
  help: the next push runs the failed file first). There is no automatic
  rollback.
- `CREATE INDEX CONCURRENTLY`, `VACUUM` and other statements that cannot run in
  a transaction run on their own, outside that transaction. Avoid them in
  migrations. If a file with such a statement fails, part of it can stay
  applied: check the production schema, and make the corrected file safe to run
  again (`IF NOT EXISTS`, `IF EXISTS`).

## Migration history

`supabase/migrations` starts with `20260916000000_production_baseline.sql`, a
dump of the production `public` schema on 2026-11-08. It replaced the 12
earlier migrations, some of which had been applied by hand. The production
history was repaired to match: the 12 old versions are marked reverted, and the
baseline is marked applied, so the deploy never runs it in production. Locally
and in CI, it builds the same schema as production from an empty database.

The baseline leaves out the Letterboxd rate experiments (schemas
`letterboxd_*_2026*` and functions `public.letterboxd_*_rpc`): they were created
by hand, hold only experiment data, and stay in production until dropped.

## Configuration

`supabase/config.toml` holds the local settings, and its `[remotes.production]`
block holds the values that differ in production. `supabase config push` merges
that block when it targets the production project. To see what a change would
push, without writing anything:

```bash
supabase config diff --project-ref igbmxubzxjfdbgmawrtr
```

Change production settings in `config.toml`, not in the dashboard. Settings
that `config push` cannot write (the CLI lists them as notes) stay in the
dashboard.

## Secrets

The jobs that use production credentials run in GitHub environments that only
`main` can use (Settings, Environments, deployment branches: `main`).

| Environment     | Secret                  | Use                                                                        |
| --------------- | ----------------------- | -------------------------------------------------------------------------- |
| `supabase-prod` | `SUPABASE_ACCESS_TOKEN` | Management API (read-only plan), `supabase link` and `config push`         |
| `supabase-prod` | `SUPABASE_DB_PASSWORD`  | `supabase db push` through the IPv4 pooler (GitHub runners lack IPv6)      |
| `vercel-prod`   | `VERCEL_TOKEN`          | Create, promote and check deployments in the `lelemathrin's projects` team |

## When the workflow fails

Open the run summary: each job writes what it did.

- **Obsolete deploy:** a newer merge is on `main`. Nothing to do; its run
  releases it.
- **Plan blocked:** the production history has a version the repo does not
  explain. Repair the history (below), then re-run the workflow.
- **Apply failed:** read the SQL error in the job log, then correct the failed
  file (see [Writing a migration](#writing-a-migration)). The migrations before
  it are applied. The old deployments still serve production.
- **Publish failed:** the migrations are applied. What serves production
  depends on the step that failed; the run summary lists the steps that passed.
  - Smoke test of the new backend, or main moved: both old deployments still
    serve production.
  - After the backend promotion (domain check, smoke test on
    `api.stremlist.com`, or frontend promotion): the new backend serves
    `api.stremlist.com`, and the old or new frontend serves `stremlist.com`.

  Check the current deployments in Vercel (Deployments, filter Production)
  before you choose. Then fix the cause and run the workflow again (Actions,
  `Supabase deploy`, Run workflow on `main`). It builds again and publishes the
  head of `main`.

## Repairing the migration history

Do this only when a plan is blocked, and only after you compare the
production schema with the migration. `supabase migration repair` writes only to the history table; it
never runs the migration SQL.

From a checkout of `main`, with the production password in the environment:

```bash
supabase link --project-ref igbmxubzxjfdbgmawrtr
# The schema already has the objects of a migration, but no history row:
supabase migration repair --status applied <version>
# A history row has no file in the repo (after you recover its SQL into Git
# under the same version, or confirm that it was undone):
supabase migration repair --status reverted <version>
```

Never mark a migration as applied when production does not have all its
objects, and never apply a migration by hand: the next deploy applies it.
