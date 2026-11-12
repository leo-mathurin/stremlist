# Watch tracking load test (T4), 2026-11-12

Prototype of ADR 0003 (`docs/adr/0003-watch-tracking-reads-stremio-on-a-postgres-schedule.md`) on branch `spike/watch-tracking-load`, run at 20,000, 40,000 and 100,000 tracked Accounts.

The run stopped before its end: the test agent failed at 03:49 UTC during the Simkl 3/s phase of the 100k step, and tour restarted later. The raw files were in RAM and are lost. The numbers below come from the agent's analysis outputs, kept in its session log. The 20k re-run with the planner fix and the exact Supabase egress were not done.

## Method

- **Backend**: the spike branch on a Vercel preview deployment (`fra1`), with every production env var overridden for the branch only (Supabase, R2, encryption key, cron secret, heartbeats, Resend, Provider client IDs and API URLs).
- **Database**: a new Supabase Free project (eu-central-1) with the repo migrations and the spike migrations (`watch_tracking`, `watch_reads`, `watch_writes`, `watch_simkl_gate`, `watch_sweep_cursor`). Deleted after the test.
- **Mocks on tour, through Tailscale Funnel**: Stremio API (a simulated library per Account, progress written every 90 s on Android TV and every 180 s on Web, then a flip at Stremio's threshold), Cinemeta, Trakt, Simkl, MDBList, an S3 server for R2. Stremio latency p50 about 60 ms, p95 about 125 ms, rare 502s.
- **Cron**: a driver on tour called the cron route every minute, as Vercel does on production.
- **Workload, per step**: 30% of Accounts play something a day, the busiest hour carries 20% of a day's plays, 1.5 plays per active Account; 60% movies (2 h), 40% episodes (45 min); 70% reach the threshold, the rest are abandoned; some plays resume with a new `/stream` request; manual marks and rewatches; 1 to 3 Destinations per Account, about 2/3 with Simkl. Each step: in-flight plays prefilled, then 45 minutes at the busiest-hour rate, with the 6-hour sweep running.
- **Latency**: from the time the mock's library item turned watched to the Destination write.

## Results

| | 20k | 40k | 100k (Simkl 1/s) |
| --- | --- | --- | --- |
| Writes measured | 1,381 | 2,793 | 5,906 |
| Latency p50 / p95 / max (s), all | 116 / 190 / 1,287 | 108 / 218 / 1,453 | 113 / 1,168 / 1,500 |
| Latency p50 / p95 / max (s), Trakt and MDBList | about 120 / 177 / 390 | see note | 88-90 / 179 / 343 |
| Latency p50 / p95 / max (s), Simkl | about 117 / 180 / 397 | see note | 951 / 1,332 / 1,500 |
| Writes over 5 min | 58 | 104 | 1,410 (Simkl backlog) |
| Coverage (written / expected) | 1,135 / 1,142 | 2,270 / 2,279 | 4,968 / 5,821 (misses are the Simkl backlog) |
| Duplicate writes | 0 | 0 | 0 |
| Cron run p50 / p95 (s) | 14.7 / 22.5 | 33 / 51.5 | 51.3 / 53.1 |
| Of which reads p95 / sweep p95 / writes p95 (s) | 2.6 / 1.8 / 19.1 | 7.8 / 2.7 / 47.3 | 14.3 / 5.8 / 46.7 |
| Reads claimed per run p50 / max | 102 / 155 | 205 / 382 | 611 / 1,132 |
| Due-read lag, oldest unclaimed (s) | 47 | 47 | 47 |
| Simkl backlog max / oldest | 23 / 16 s | 57 / 75 s | 1,456 / 21.7 min |
| Postgres connections | 25 | 25 | 25 |
| Supabase CPU busy | 1.2% (sweep only) | 3.3% | low (the exact figure is lost) |
| Database size | 35 MB | 58 MB | 126 MB |
| R2 state objects (p50 / p95 / max size) | 20,000, 90 MB | 40,000, 181 MB | 100,000, 455 MB (3 KB / 13 KB / 42 KB) |

Notes:

- **Late writes at 20k and 40k come from a prototype bug, not the design.** A Web play seen at its first read was taken as stalled, so short titles were read late. Fixed in `abe5508` before the 40k step, but the 40k step was prefilled with plays planned by the old code. At 40k, plays started after the fix had no write over 5 minutes: p95 178 to 193 s (Android TV and Web). Plays prefilled with the old code: 102 late of 1,148.
- **Simkl is the bottleneck at 100k.** The cron run is serial: reads, then the sweep, then writes, with Simkl paced at 1 POST/s in what is left of the minute. Real Simkl throughput was under 1 write/s, against about 1.2 needed. At 3/s (started at 03:39), the backlog went from 1,456 to 933 in 10 minutes (read from the database before deletion): about 50 fewer each minute, so 3/s drains it.
- **The cron run reaches 51 to 53 s at 100k**, close to the 1-minute interval. Writes take most of it. Reads and the sweep take at most 20 s.
- **Errors**: 108 "socket is closed" and 81 `ECONNRESET` on the Funnel, 48 mock 502s, all retried at the next cycle. No failed write.

### Reads per play (planner replay)

| Play | Plays | Stremio reads per play |
| --- | --- | --- |
| Movie, watched | 6,819 | 3.84 |
| Episode, watched | 4,463 | 3.81 |
| Movie, watched after a resume | 1,719 | 6.74 |
| Episode, watched after a resume | 1,164 | 9.65 |
| Movie, abandoned | 3,497 | 9.23 |
| Episode, abandoned | 2,338 | 8.45 |
| All | | 5.9 |

Abandoned plays cost the most, because the rule waits 10 minutes without progress before it slows down. Latency of the planner alone (perfect network): p50 97 s, p95 145 s.

### Stremio load

- 20k: 3.6 reads/s on average, 7.3/s at most over 30 s, about 4.4 million calls a month.
- 40k: about 8.9 million calls a month.
- 100k: bursts up to 49.6 reads/s. The controlled test on the real `api.strem.io` went up to 20/s only.
- `datastoreMeta` (sweep): about 20 MB an hour at 20k.
- `/stream` answers on the preview: p50 81 to 91 ms, p95 108 to 134 ms.

### Database (pg_stat_statements, 100k step, 56 minutes)

118,855 calls, 115 s in total. The slowest by total time: `claim_watch_reads` (92 ms mean), `watch_sweep_accounts` (240 ms mean), then per-read lookups of the Account, its Connections and its tracking row (0.7 to 1.3 ms each, about 9,000 to 16,000 calls each).

## Cost

Measured Vercel use per run, extrapolated to a month with the workload model.

| | 20k | 40k |
| --- | --- | --- |
| Vercel Active CPU | 4 h, 0.57 $ | 9.4 h, 1.33 $ |
| Vercel Provisioned Memory | 128 GB-h, 1.47 $ | 287 GB-h, 3.28 $ |
| Vercel invocations | 352k, 0.21 $ | 664k, 0.40 $ |
| **Vercel total** | **2.25 $/month** | **5.01 $/month** |
| R2 (Class A / Class B / storage) | 526k / 3.0M / 0.09 GB: 0 $ after the free tier | 1.35M / 6.0M / 0.18 GB: 1.55 $ |
| Supabase database size | 35 MB | 58 MB |
| Supabase egress (projected, see below) | 8.9 GB/month | 16.2 GB/month |

The 100k cost extrapolation was not done. Memory is the largest Vercel share: the cron instance waits on the network for most of its run. At 100k it runs for most of each minute, so expect roughly 2.5 times the 40k figure.

**Supabase egress is the open risk.** The projection uses the outbound traffic of the database VM, which includes Supabase's own background traffic, and it grows with the number of Accounts. Supabase Free includes 5 GB of egress a month. The agent added a counter of PostgREST response bytes (`2461f56`) but did not get its result before it stopped.

The test itself cost at most 0.25 $ on Vercel (the `stremlist-backend` total went from 2.11 $ to 2.36 $ between 2026-11-11 and 2026-11-12, production traffic included).

## Verdict

The design holds on Vercel Pro and Supabase Free for CPU, connections, database size and latency up to 100,000 Accounts: Trakt and MDBList writes at p95 about 3 minutes, no duplicate, no lost write, Supabase CPU in single digits, 25 connections, 126 MB. Four changes are needed before the feature:

1. **Simkl writes must not share the cron run with reads.** Run them in their own invocation (or in parallel inside the run) so their pacing never takes the reads' time, and use 3/s from the start of the backlog alert. At 40k, 1/s is enough.
2. **Measure and cut Supabase egress.** One RPC per claimed batch that returns the Account, its Connections and its tracking row would replace three lookups per read. Measure the PostgREST bytes before launch.
3. **Split the cron work above about 60k Accounts**, as the run reaches 51 s at 100k: several claims in parallel, or two cron routes.
4. **Smooth reads to `api.strem.io`**: at 100k the bursts reach 49.6/s, above the tested 20/s. A cap per run (for example 20/s) only delays reads by seconds.

Optional: wait 5 minutes without progress instead of 10 before slowing down (3 missed Android TV writes). Abandoned plays are a third of plays and cost 9 reads each.

## Cleanup

- Supabase test project `stremlist-watch-load` deleted.
- The 32 Preview env vars for the branch removed. A new push to the branch would build with production values: do not push to it again without them.
- Funnel on port 10000 off. Mocks stopped (tour restart). Test secrets folder deleted.
- Kept: the branch and its preview deployment.
