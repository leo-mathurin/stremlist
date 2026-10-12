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
