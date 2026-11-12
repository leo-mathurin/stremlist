# Watch tracking reads Stremio on a Postgres schedule

Watch tracking is free and needs a Stremio link. Stremio's own watched status is the only reference: a movie counts as watched when its `timesWatched` goes from 0 to more than 0, an episode when a new bit appears in the decoded `watched` bitfield of its series. Stremio sends no addon event when a title crosses its watched threshold during playback, and the Android TV app sends no events at all. So Stremlist reads the library item from `api.strem.io` on a schedule, and uses the requests it already receives as the signal of when to read.

The trigger is a `/stream` request: every Stremio app asks the installed addons for streams before it plays a title. Accounts with Watch tracking declare the `stream` resource and get an empty list. On such a request, the backend reads that title's library item at once, computes the earliest time it can turn watched from `timeWatched` and `duration`, then reads it every 2 minutes for 30 minutes, every 5 minutes after that, and stops 3 hours after the expected end. When `timeWatched` has not moved for 5 minutes, the playback has stopped (Android TV writes its progress every 90 seconds, so this is 3 missed writes): the item is read every 30 minutes until its expected end, then no more. A new `/stream` request starts the cycle again, since Stremio asks for streams to resume a title. Stremio Web's `pause` and `stop` player events add an immediate read. A slow sweep every 6 hours (`datastoreMeta`, then `datastoreGet` on the changed items) catches what the trigger misses. It compares with the previous watched state of the Account, kept as one R2 object per Account (3 KB at p50, 42 KB at most in the load test), so the Supabase Free disk holds only the due reads. The Watched baseline is read at activation and is never sent.

The reads run from a Vercel Cron route every minute. Due reads are rows in a Postgres table with a lease, as for the other queues. One Postgres function claims a batch and returns, in a compact form, everything the batch needs: the tracking rows, the Accounts and their Connections. There is no lookup per read. Each run reads Stremio at no more than 20 requests per second; due reads over that cap wait for the next run. The new watched titles go to every Destination with the existing Action code (`watched_at` = `lastWatched`). A failed write is retried for 72 hours (1 min, 5 min, 30 min, then every 6 hours); before a retry after an uncertain answer, the backend reads the Provider's history.

Simkl writes run in parallel with the reads, in the same cron run, each with its own time budget, so Simkl pacing never delays reads. They go through one global limiter: 1 POST per second, and 3 per second while the oldest queued Simkl write is more than 10 minutes old. That condition also fires an alert. A 429 from Simkl sets the limiter back to 1 per second. Above about 60,000 Accounts, the cron run claims several batches in parallel.

A Trakt Destination is off while Stremio's own Trakt integration is connected on the same Stremio account (`getUser` shows a Trakt token), so a title is never written twice. The configure page explains that Stremio's Trakt misses titles closed before the end, and that disconnecting it there lets Stremlist do the job.

## Considered options

- **A Cloudflare Worker with one Durable Object per Account**, waking itself with alarms. Precise to the second and with no shared queue. Rejected: about the same price, and it adds a second platform, a second copy of `CONNECTION_ENCRYPTION_KEY` and the Stremio keys, and state split between Supabase and the objects. Disconnecting would need both stores to agree. It stays the fallback if Supabase Free cannot hold the queue.
- **Reading only on Stremio Web player events.** Found 4 of 10 watched titles in the controlled test, against 10 of 10 for reads after every pause and stop, and does nothing for Android TV.
- **Writing to Trakt even when Stremio's Trakt is connected.** Two apps would write the same play.
- **Supabase Pro (25 $ a month) for its egress allowance.** Rejected while the batch function and an R2 cache of Account data can keep egress under the 5 GB of Supabase Free.

## Consequences

- The schedule has a precision of 1 minute. The target latency is under 5 minutes from Stremio's change to the Destination.
- Vercel runs cron jobs only on the production deployment.
- A Stremio app that is force-stopped before it writes its progress (Android TV writes every 90 seconds, and at once on Back, Home or a manual mark) never shows the title as watched, so Stremlist never sends it.
- A playback paused more than 5 minutes, then resumed without a new `/stream` request, is read again up to 30 minutes later.
- Every read leaves from Vercel `fra1` addresses, at no more than 20 requests per second to `api.strem.io`.
- Member devices send nothing more than the `/stream` request they already send, with an empty answer. Each MDBList write uses one of the member's 1,000 daily requests.
- Supabase egress is the limit of Supabase Free. The bytes the batch function sends are measured before launch. If the projection is over 5 GB a month, Account data is cached in R2.
- Expected cost: about 2.25 $ a month on Vercel at 20,000 Accounts, about 5 $ on Vercel and 1.55 $ on R2 at 40,000.

## Evidence

- The controlled tests of 2026-11-11 (`docs/research/watch-tracking-tests-2026-11-11.md`): Stremio Web, an Android TV 1.10.4 emulator, Stremio's Trakt integration, rate limits of `api.strem.io`, Trakt, Simkl and MDBList.
- The load test of 2026-11-12 (`docs/research/watch-tracking-load-2026-11-12.md`): a prototype on a preview deployment with mocks, at 20,000, 40,000 and 100,000 Accounts. Trakt and MDBList writes at p95 about 3 minutes, no duplicate and no lost write, 25 Postgres connections, Supabase CPU under 4%, 126 MB of database at 100,000. It showed the changes above: at 100,000 the serial cron run took 51 to 53 s and the Simkl queue reached 1,456 writes (21.7 minutes) at 1 per second, Stremio reads reached 49.6 per second in bursts, and Supabase egress was projected at 8.9 GB a month at 20,000 with three lookups per read. Abandoned plays cost about 9 reads each with a 10-minute stall rule.
