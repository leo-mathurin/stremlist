# Local load testing

`stress:load` runs the real backend against the local stack with k6 and fake
IMDb GraphQL responses. Other external hosts return 503, so Trakt is tested as
an outage. This differs from `test:stress`, the IMDb scraper's Vitest test.

Requires Docker, the local stack (`bun run dev:local` in `apps/backend`), and k6
on `PATH` (or set `K6`). The load test uses its own `stremlist-stress` bucket and
server on port 7099.

```sh
cd apps/backend
bun run stress:load                          # 6,000 Accounts, all scenarios
bun run stress:load --accounts 600           # smaller seed
bun run stress:load --scenarios cold,trakt
bun run stress:load --help                   # options and STRESS_* overrides
```

| Scenario | Traffic                                                  |
| -------- | -------------------------------------------------------- |
| `cold`   | Every Account opens its board once with empty caches     |
| `warm`   | Rising arrival rate, reusing the cold caches             |
| `trakt`  | Action users open titles while Trakt is down             |
| `stale`  | Concurrent reads with a one-minute TTL and growing lists |

The runner exits with 1 when a check fails. It stops its server/k6 and deletes
seeded Accounts and its bucket after completion, errors or Ctrl-C. The next run
cleans up leftovers from a hard kill. Logs, k6 summaries and the report are in
`.dev.local/stress/<date>/` at the repository root.

Reports include response times, success/5xx rates, warning cards, outbound calls,
resource peaks and database/R2 sizes before cleanup. Pass/fail thresholds live
in `report.ts`; CLI defaults and options live in `run.ts --help`.

One machine hosts the database, storage, backend and k6; one backend process
serves all requests. Use results to compare changes, not as production capacity
figures. Only IMDb has realistic fixture data; other Providers are outage cases.

## Letterboxd gate

`stress/letterboxd-gate.ts` loads the shared Letterboxd gate
(`public.letterboxd_take` and `public.letterboxd_report`) without the backend.
Simulated users each add one list at an interactive priority. Each list is 1 to
100 pages, with the size model of the Letterboxd lab plus 1% of 100-page lists.
A fake Letterboxd answers each page in 200 ms. Users arrive evenly over the
arrival window.

```sh
cd apps/backend
# Against a migrated Postgres, with a direct connection:
STRESS_GATE_DATABASE_URL=postgres://… bun run stress:letterboxd-gate --target pg
# Through PostgREST, like the backend:
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… bun run stress:letterboxd-gate --target rest
```

Options: `--users 5000 --arrival-minutes 10 --drain-minutes 20 --rate 10
--schema public --out report.json`. The run uses its own gate row
(`stress-<time>`) and deletes it at the end (with `--schema`, the row goes
away when that schema is dropped). It fails if more than
`rate + burst` requests start in any second or `10 × rate + burst` in any ten
seconds, or if a gate call fails. The report also gives gate call latency, the
time users wait for their first page and their whole list, the share that would
see the queue state (an estimated wait of 3 s or more), and the share that
would get the Stremio card (first page after 10 s).
