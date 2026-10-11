# Load test

`bun run stress:load` runs the real backend app against the local stack and
sends Stremio traffic to it with [k6](https://k6.io). It seeds thousands of
Accounts, runs a set of scenarios, prints a report, checks pass/fail rules and
then deletes everything it created.

This is not the `test:stress` script. That one is a Vitest test of the IMDb
scraper.

## What it tests

The backend runs in one Bun process (`stress/server.ts`). IMDb is replaced by a
fake GraphQL API (`stress/mock-fetch.ts`):

- Each watchlist has a fixed size: 60% have 20 to 200 titles, 30% have 200 to
  1,000, 9% have 1,000 to 3,000 and 1% have 5,000 to 12,000.
- 3% of the lists are private.
- Each call waits 300 ms plus 0.3 ms per title.
- Every other external host answers 503 after 50 ms. The report counts these
  calls per host. So Trakt is always down.

The seed has 70% legacy installs (one IMDb watchlist, `/ur…/` URLs) and 30%
private Accounts. Half of the private Accounts show "New titles", 30% have an
IMDb chart and 15% have a merged list. The table `public.stress_accounts` keeps
track of the seeded Accounts.

The scenarios run in this order:

| Scenario | What happens                                                                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cold`   | Each Account opens its Stremio board once, with empty caches: the manifest, all catalogs in parallel, then 1 or 2 titles (meta and streams). 100 parallel users.                                                 |
| `warm`   | Random Accounts open their board at a rising rate: one third of the peak rate, then the peak rate (150 board opens per second by default).                                                                       |
| `trakt`  | 50 private Accounts get a Trakt Connection with Actions on. Trakt is down. The 50 users open titles for about 40 s. In the middle, one of them loads a normal Trakt catalog (`me/watchlist`).                    |
| `stale`  | A new server with a 1 minute cache TTL and lists that grow by one title a minute. Random Accounts open their board at 60 per second for about 3 minutes, so the caches expire and refresh while users load them. |

`warm` and `stale` reuse the caches that `cold` fills. If you skip `cold`,
`warm` starts with empty caches.

## Prerequisites

- Docker, and the local stack: run `bun run dev:local` once in `apps/backend`.
  The stack can keep running. The load test uses its own bucket
  (`stremlist-stress`) and its own server on port 7099, so it does not touch
  the dev server or the `stremlist-dev` bucket.
- k6 on the `PATH` (`brew install k6`), or set `K6` to its path.

## How to run

```sh
cd apps/backend
bun run stress:load                          # 6,000 Accounts, all scenarios, about 10 minutes
bun run stress:load --accounts 600           # smaller seed
bun run stress:load --scenarios cold,trakt   # some scenarios only
bun run stress:load --help                   # all options
```

| Option           | Environment variable  | Default | Meaning                                  |
| ---------------- | --------------------- | ------- | ---------------------------------------- |
| `--accounts`     | `STRESS_ACCOUNTS`     | 6000    | Accounts to seed                         |
| `--scenarios`    | `STRESS_SCENARIOS`    | all     | Comma separated list of scenarios        |
| `--base-latency` | `STRESS_BASE_LATENCY` | 300     | Fake IMDb latency per call, in ms        |
| `--item-latency` | `STRESS_ITEM_LATENCY` | 0.3     | Extra fake IMDb latency per title, in ms |
| `--warm-rate`    | `STRESS_WARM_RATE`    | 150     | Peak board opens per second in `warm`    |
| `--stale-rate`   | `STRESS_STALE_RATE`   | 60      | Board opens per second in `stale`        |
| `--hold`         | `STRESS_HOLD`         | 60      | Seconds of each steady phase             |
| `--vus`          | `STRESS_VUS`          | 100     | Parallel users in `cold`                 |
| `--port`         | `STRESS_PORT`         | 7099    | Port of the stress server                |

The command exits with 1 when a check fails. It always cleans up, also after
an error or Ctrl-C: it stops the server and k6, deletes the seeded Accounts
(their Lists, Connections and syncs cascade) and removes the bucket. A run that
was killed hard (`kill -9`) is cleaned up by the next run.

Logs, k6 summaries and the report are in
`.dev.local/stress/<date>/` at the repository root (ignored by git):
`server-*.log`, `k6-*.log`, `summary-*.json`, `report.txt`.

## How to read the report

Each scenario has one block:

```text
== Warm ramp: 5,790 requests in 70 s (83 req/s), 100.00% OK, 0 5xx
route       requests       OK    p50     p95     p99     max  5xx
catalog        2,388  100.00%  13 ms  274 ms  482 ms  850 ms    0
...
catalogs with a warning card: 68
external calls: api.graphql.imdb.com 37
IMDb pages 37, items 0, max in flight 3
peak RSS 508 MB, DB connections 14 (active 0), peak CPU: postgres 14%, postgrest 22%, r2 19%
PASS  OK >= 99.9% (100.00%)
PASS  5xx <= 5 (0.1% budget): 0
```

- **OK** is the share of answers with status 200. **5xx** also counts
  timeouts and network errors.
- **p50, p95, p99, max** are response times seen by k6.
- **catalogs with a warning card**: catalogs that answer with a Stremlist card
  instead of titles, for example a private IMDb list.
- **external calls**: calls per external host. In `trakt`, the calls to
  `api.trakt.tv` show if the backend backs off when Trakt is down.
- **max in flight**: the most external calls open at the same time.
- **peak RSS** comes from the server process. **DB connections** and **peak
  CPU** are sampled from Docker every few seconds. PostgREST is the Supabase
  REST API between the backend and Postgres.

The last block shows the database size and the largest tables, and the R2
objects and bytes per prefix (`history/`, `connections/`, `watchlists/`, and
any other). It is measured before cleanup. Sizes include the data of the dev
stack, so compare them with the size before seeding.

The checks:

| Scenario | Check                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| all      | 5xx at most 0.1% of the requests                                                                               |
| `cold`   | OK at least 99.5%                                                                                              |
| `warm`   | OK at least 99.9%                                                                                              |
| `stale`  | OK at least 99.9%                                                                                              |
| `trakt`  | Streams OK at least 99%                                                                                        |
| `trakt`  | The Trakt catalog answers within 10 s (an error answer is fine, a hang is not)                                 |
| `trakt`  | Calls to `api.trakt.tv` stay at most twice the expected count: 5 per Account, plus 1 per Trakt catalog request |

## Limits

- Everything runs on one machine in Docker. Postgres, PostgREST and the R2
  container share its CPU with the server and k6. Absolute numbers are lower
  than in production. Use them to compare runs, not as capacity figures.
- One server process. Production runs many instances, so per-instance limits
  (memory, in-flight calls) matter more than the total rate.
- Only IMDb is faked with realistic data. Other Providers, TMDB and RPDB
  always answer 503. Trakt traffic is only tested as an outage.
- The fake IMDb latency is fixed. Real IMDb has slow tails and rate limits.

## Baseline

First run, 6,000 Accounts, on an Apple silicon Mac, October 2026:

| Scenario    | Result                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------- |
| Cold storm  | 6,000 Accounts, 36,887 requests, 99.99% OK, catalog p95 3.7 s                                     |
| Warm ramp   | 350 req/s, 100% OK, catalog median 35 ms. One instance saturates near 150 board opens per second. |
| Stale storm | 147 req/s, 100% OK                                                                                |

Before the Trakt fix, the Trakt catalog in the `trakt` scenario hung for
120 s. The first run also wrote 3.05 million detection rows (1 GB) to
Postgres, before the history moved to R2 (ADR 0008).

After the fixes, 6,000 Accounts, same Mac, `bun run stress:load`:

| Scenario     | Result                                                                               |
| ------------ | ------------------------------------------------------------------------------------ |
| Cold storm   | 36,807 requests, 333 req/s, 100% OK, catalog p95 2.4 s                               |
| Warm ramp    | 81,187 requests, 477 req/s, 100% OK, catalog p50 16 ms, p95 217 ms                   |
| Trakt outage | 2,000 streams 100% OK; Trakt catalog answers in 105 ms; 252 Trakt calls (limit 504)  |
| Stale storm  | 49,057 requests, 276 req/s, 99.98% OK (8 errors from the overloaded local PostgREST) |
| Storage      | database +1.1 MB; R2 `history/` 6,882 objects, 122 MB                                |
