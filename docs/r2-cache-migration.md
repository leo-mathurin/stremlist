# Cloudflare R2 cache rollout

Stremlist keeps user configuration in Supabase, but stores IMDb catalog cache
objects in a private Cloudflare R2 bucket. Each refresh writes an immutable,
gzip-compressed catalog generation, then atomically switches a small manifest
to that generation. Readers see either the old complete catalog or the new one.
The manifest also holds a compact title index, so a metadata miss does not
download every catalog.

This layout costs two R2 writes per watchlist refresh. Do not split a catalog
into per-item objects. Per-item writes would make Class A operations the first
free-tier constraint.

## 1. Create the R2 bucket

1. In Cloudflare, create a private Standard R2 bucket named `stremlist-cache`.
2. Create an R2 API token with Object Read & Write access, scoped only to that
   bucket.
3. Add a lifecycle rule that deletes objects after 30 days. Active catalogs are
   refreshed before then. The rule also removes inactive users and unreferenced
   generations left by interrupted or concurrent refreshes.

Set these variables in `apps/backend/.env` and in the Vercel backend project:

```dotenv
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=stremlist-cache
```

`R2_ENDPOINT` is reserved for local S3-compatible test servers. Leave it unset
in production so the backend derives the Cloudflare endpoint from
`R2_ACCOUNT_ID`.

Do not expose the R2 credentials to the frontend. The bucket does not need a
public domain.

## 2. Deploy and verify

Deploy the backend with all four R2 variables. The existing Supabase cache is
not copied. Catalogs will initially miss the cache and populate R2 as users
request them.

Verify:

1. A catalog with more than 100 titles returns 100 titles on its first page and
   the next titles at `/skip=100.json`.
2. Opening a title from the catalog resolves its `/meta/...json` endpoint.
3. Manual refresh updates the catalog without errors.
4. R2 metrics show successful Class A and Class B operations.

Rollback before the SQL cleanup is simply a deployment of the previous backend
version; the Supabase cache tables are still intact.

## 3. Reclaim Supabase storage

After production has been stable for at least one full cache TTL, apply
`supabase/migrations/20260826000000_drop_cache_tables_after_r2.sql`. The drop
is a normal migration so a fresh database replay matches
`packages/shared/src/database.types.ts`. The tables are dropped, not merely
emptied, so their relation storage is released immediately.

Then run this in the Supabase SQL editor:

```sql
SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size;
```

Confirm the reported size is below the current Supabase Free limit, then change
the subscription to Free. Keep normal alerts on database size and R2 operations;
the two services have separate quotas.
