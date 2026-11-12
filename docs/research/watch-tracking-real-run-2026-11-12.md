# Watch tracking on the real APIs, 2026-11-12

The branch `feat/auto-watch-status-sync` ran on a local backend with a local Supabase and R2 store, against the real `api.strem.io`, Cinemeta, Simkl and MDBList, then Trakt. Only the test accounts of the 2026-11-11 tests were used. Every account was restored at the end.

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

Trakt was first left out: `developer.trakt.tv` needs a linked GitHub account to create a test app (see the 2026-11-11 report). It ran later the same day, in the section below.

## Trakt, with the Stremlist Trakt app

Stremlist's own Trakt app (a public PKCE client with no secret, the `localhost:7001` callback registered) authorized the Trakt test account. The test account signed in with an email code, in a browser session without the owner's sign-ins, and `/users/me` confirmed the account before the run. The token stays in the test credentials file. The production backend, database and callback had no part: the code went from the browser to the local run, which exchanged it. All calls used the test user's token, so they count against that user's Trakt limits, not the shared app limit.

The run had all three Destinations (Trakt, Simkl, MDBList), with the same movie (`tt0031381`) and Game of Thrones 1:3 and 1:7, marked at once. A preload sent the first run's Trakt `POST /sync/history` requests for real but threw away their answers. That is the "answer that never came" case.

| Check | Result |
| --- | --- |
| Run 1 | Two Trakt requests reached Trakt (the series with both episodes in one request, and the movie). Their answers were lost: the 3 rows stayed queued, `uncertain`, attempt 1. Trakt history: 1 movie play, 1:3 and 1:7. Simkl and MDBList got the titles. |
| Run 2 (retries made due at once) | Stremlist read `GET /sync/history/movies` and `/sync/history/episodes` around the play time, found the three plays, and closed the rows **without a second `POST`**. |
| Runs 3 and 4 | Nothing to send. Queue empty. |
| Trakt at the end | Exactly 1 movie play and 1 play each of 1:3 and 1:7: no duplicate. |
| Configure API | Trakt: last title, last success, no error, nothing pending. Stremio's own Trakt reported not connected, so Trakt was not paused. |
| Cleanup | Trakt `sync/history/remove` deleted 1 movie and 2 episodes, history empty again; Simkl, MDBList and the Stremio items restored; Watch tracking off. |

Trakt keeps `watched_at` only to the minute: Stremio's `lastWatched` was 18:27:50.727, and Trakt stored 18:27:00. The history check looks 60 seconds on each side of the time sent, which always holds the stored minute, so this run found every play. Not tested on the real API: the pause while Stremio's own Trakt is connected (fixture tests only).

## Supabase egress per read

`claim_watch_reads` returns about 740 bytes per row without compression (200 rows, synthetic keys of the real length), and about 94 bytes per row with gzip. The local gateway does not compress; whether Supabase's hosted gateway compresses these answers was not checked.

With the load test's 4.4 million reads a month at 20,000 Accounts, the claims send about 3.3 GB a month without compression, and the sweep about 0.5 GB more. That stays under the 5 GB of Supabase Free at 20,000 Accounts, but not at 40,000 (about 7.6 GB) unless the answers are compressed. The next step, if the dashboard shows more, is the R2 cache of Account data in ADR 0003.
