# Watch tracking on the real APIs, 2026-11-12

The branch `feat/auto-watch-status-sync` ran on a local backend with a local Supabase and R2 store, against the real `api.strem.io`, Cinemeta, Simkl and MDBList. Only the test accounts of the 2026-11-11 tests were used. Every account was restored at the end.

## Method

- Backend: `src/dev.ts` with the Simkl test app, a Stremio link to the first test Stremio account, a Simkl Connection with the test user's tokens, and an MDBList Connection. The MDBList test account has an API key and no OAuth app, so a preload changed only the MDBList `Authorization: Bearer` header into the `apikey` parameter. Every other request went out unchanged.
- Turning Watch tracking on read the real library (12 items) as the Watched baseline.
- A movie (`tt0031381`, not watched): `/stream`, then the library item was set to `timesWatched: 1` with `datastorePut`, as a client does at the threshold, then a `player` `stop` event.
- An episode: Game of Thrones 1:3 was added to the real `watched` field (1:1, 1:2 and 1:4 to 1:6 were already watched), then a `library` `watched` event.
- Three cron runs.

## Results

| Check | Result |
| --- | --- |
| `watched` field of the real library, decoded with real Cinemeta | Breaking Bad 1:1 to 1:7 and 2:1, Game of Thrones 1:1, 1:2, 1:4 to 1:6. Each anchor is the last watched episode, as Stremio writes it. |
| Writes sent | Only the movie and GoT 1:3. No episode of the baseline. |
| Simkl | Movie `last_watched_at` = Stremio's `lastWatched` (11:36:44). GoT 1:3 watched. The episode, queued by the event before the run, went in run 1; the movie, found in run 1, went in run 2. |
| MDBList | Movie and show `last_watched_at` = 11:36:44.192Z: MDBList keeps `watched_at`. |
| Configure API | Both Destinations: last title, last success, no error, nothing pending. |
| Cleanup | Simkl and MDBList without the two titles again (0 movies, 0 shows), Stremio items restored, Watch tracking off, local Account deleted. |

Not run: **Trakt**. There is no Trakt test app: `developer.trakt.tv` needs a linked GitHub account (see the 2026-11-11 report). Trakt writes are covered by the fixture tests only, and the history check before a retry has never met the real API.

## Supabase egress per read

`claim_watch_reads` returns about 740 bytes per row without compression (200 rows, synthetic keys of the real length), and about 94 bytes per row with gzip. The local gateway does not compress; whether Supabase's hosted gateway compresses these answers was not checked.

With the load test's 4.4 million reads a month at 20,000 Accounts, the claims send about 3.3 GB a month without compression, and the sweep about 0.5 GB more. That stays under the 5 GB of Supabase Free at 20,000 Accounts, but not at 40,000 (about 7.6 GB) unless the answers are compressed. The next step, if the dashboard shows more, is the R2 cache of Account data in ADR 0003.
