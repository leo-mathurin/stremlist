# Watch tracking reads Stremio on a Postgres schedule

Watch tracking is free and needs a Stremio link. Stremio's own watched status is the only reference: a movie counts as watched when its `timesWatched` goes from 0 to more than 0, an episode when a new bit appears in the decoded `watched` bitfield of its series. Stremio sends no addon event when a title crosses its watched threshold during playback, and the Android TV app sends no events at all. So Stremlist reads the library item from `api.strem.io` on a schedule, and uses the requests it already receives as the signal of when to read.

The trigger is a `/stream` request: every Stremio app asks the installed addons for streams before it plays a title. Accounts with Watch tracking declare the `stream` resource and get an empty list. On such a request, the backend reads that title's library item at once, computes the earliest time it can turn watched from `timeWatched` and `duration`, then reads it every 2 minutes for 30 minutes, every 5 minutes after that, and stops 3 hours after the expected end. When `timeWatched` has not moved for 10 minutes, the playback has stopped (Android TV writes its progress every 90 seconds): the item is read every 30 minutes until its expected end, then no more. A new `/stream` request starts the cycle again, since Stremio asks for streams to resume a title. Stremio Web's `pause` and `stop` player events add an immediate read. A slow sweep every 6 hours (`datastoreMeta`, then `datastoreGet` on the changed items) catches what the trigger misses. It compares with the previous watched state of the Account, kept as one R2 object per Account (1 to 3 KB), so the Supabase Free disk holds only the due reads. The Watched baseline is read at activation and is never sent.

The reads run from a Vercel Cron route every minute. Due reads are rows in a Postgres table with a lease, as for the other queues. Each run takes the due rows, reads Stremio, and writes the new watched titles to every Destination with the existing Action code (`watched_at` = `lastWatched`). A failed write is retried for 72 hours (1 min, 5 min, 30 min, then every 6 hours); before a retry after an uncertain answer, the backend reads the Provider's history. Simkl writes go through one global limiter, 1 POST per second at launch, raised to 3 per second near 40,000 Accounts if Simkl answers no 429. An alert fires when the Simkl backlog passes 10 minutes.

A Trakt Destination is off while Stremio's own Trakt integration is connected on the same Stremio account (`getUser` shows a Trakt token), so a title is never written twice. The configure page explains that Stremio's Trakt misses titles closed before the end, and that disconnecting it there lets Stremlist do the job.

## Considered options

- **A Cloudflare Worker with one Durable Object per Account**, waking itself with alarms. Precise to the second and with no shared queue. Rejected: about the same price (5 $ a month base, then about 6 to 7 $ a month at 20,000 Accounts against about 5 $ for the Vercel schedule), and it adds a second platform, a second copy of `CONNECTION_ENCRYPTION_KEY` and the Stremio keys, and state split between Supabase and the objects. Disconnecting would need both stores to agree. It stays the fallback if Supabase Free cannot hold the queue.
- **Reading only on Stremio Web player events.** Found 4 of 10 watched titles in the controlled test, against 10 of 10 for reads after every pause and stop, and does nothing for Android TV.
- **Writing to Trakt even when Stremio's Trakt is connected.** Two apps would write the same play.

## Consequences

- The schedule has a precision of 1 minute. The target latency is under 5 minutes from Stremio's change to the Destination.
- Vercel runs cron jobs only on the production deployment.
- A Stremio app that is force-stopped before it writes its progress (Android TV writes every 90 seconds, and at once on Back, Home or a manual mark) never shows the title as watched, so Stremlist never sends it.
- Every read leaves from Vercel `fra1` addresses. The controlled test stayed under 20 requests per second to `api.strem.io` with a p95 under 125 ms.
- Member devices send nothing more than the `/stream` request they already send, with an empty answer. Each MDBList write uses one of the member's 1,000 daily requests.

## Evidence

The controlled tests of 2026-11-11 (`docs/research/watch-tracking-tests-2026-11-11.md`): Stremio Web, an Android TV 1.10.4 emulator, Stremio's Trakt integration, rate limits of `api.strem.io`, Trakt, Simkl and MDBList. The load test at 20,000, 40,000 and 100,000 Accounts on a preview deployment is pending.
