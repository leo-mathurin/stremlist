# Watch tracking: experiments on Stremio, Trakt, Simkl and MDBList

Date: 11 November 2026. All traffic left from tour (this machine), with test
accounts and a test OAuth app only. No production credential, client ID,
database or infrastructure was used. Times are UTC. Raw data stays outside the
repository, under `/tmp/claude-1000/watch-tracking-tests/` (see "Raw data").

"Native" means Stremio's own library state in its cloud (`api.strem.io`,
collection `libraryItem`). "Unverified" marks every point that this run did not
observe directly.

## Summary of answers

1. **Approach (a), "an event triggers a read of the native state", is correct
   in 10 of 10 web scenarios. Approach (c), "watched if
   `currentTime/duration >= 0.8` on stop", is correct in 4 of 10.** (c) gives a
   false "watched" after a seek to the end (S2), misses a real 75% watch (S3),
   misses every manual mark (S5, S8, S9), and counts a replay that Stremio does
   not count (S10). Approach (a) needs one change to the plan: an automatic
   watch (the 70% threshold) sends **no** `library/watched` event. Only
   `player` `pause`/`stop` arrive, so (a) must read the native state after
   every `stop` (and `pause`), not only after `library` events.
2. **The native state matched the UI in every case that this run checked**
   (Stremio Web movies and episodes, Android TV episode marks). Three
   semantic traps exist; see answer 2 below.
3. **Android TV (1.10.4) sends no `player` or `library` events.** It pushes
   the native state every 90 s during playback, and at once on Back, Home and
   a manual episode mark. A force-stop loses everything after the last push,
   including a watched threshold crossing. Fallback: poll `datastoreMeta`.
4. **Stremio's Trakt connection is detectable**: `getUser.trakt` holds tokens,
   and after a client reload the collection holds an addon with ID
   `org.trakt.<number>`. Stremio's scrobble made one Trakt history entry at a
   natural end of a movie. Whether a later Stremlist `POST /sync/history`
   makes a duplicate is **unverified**: Trakt now requires a linked GitHub
   account to create an API app, so no Trakt test app exists.
5. **Simkl: not answered.** Simkl normalizes Gmail addresses, so a second test
   user could not be created. Evidence with one user: the counter
   (`X-RateLimit-Limit: 500`) is present only on requests with a user token, and
   GET and POST share it.
6. Measured limits and latencies are in the section "Inputs for the load
   simulation".

## Setup

| Item                     | Version or value                                                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stremio Web              | App 6.0.7, build `f0222603bb8119d8a63958ad8acfd025de973f2e`, at `web.stremio.com` (the main URL; no beta URL was needed)                                                                                  |
| Stremio Android TV       | 1.10.4, x86_64 APK, versionCode 34194308, from `dl.strem.io/android/v1.10.4-androidTV/`                                                                                                                   |
| Stremio Android (mobile) | 2.3.2 x86 APK, static analysis only                                                                                                                                                                       |
| Stremio desktop Linux    | 4.4.168 `.deb`, static analysis only (not installed)                                                                                                                                                      |
| stremio-core source      | `main` after PR #1070 (merged 2026-10-02), read with `gh api`                                                                                                                                             |
| Android emulator         | 37.2.13.0, AVD `wt-androidtv-36`, system image `android-36;android-tv;x86_64` (Android 16, `BT2A.260319.001`), 4 GB RAM, KVM                                                                              |
| Browser                  | Chrome 154.0.8037.92 driven by agent-browser 0.38.1, headed on a private Xvfb display                                                                                                                     |
| Harness                  | Bun 1.4.4, ffmpeg n8.1.3, Tailscale 1.104.5                                                                                                                                                               |
| APK signature            | Both APKs verify with APK Signature Scheme v2; signer `CN=Ivo Georgiev, OU=Engineering, O=Stremio, L=Sofia, C=BG`, certificate SHA-256 `7e6a979c968f771e3fbcf2c2e8718ce61e708d87caf91fc13e2d4c19a8022c6b` |

Test addon (throwaway, Bun): manifest resources `catalog`, `stream`, `player`
and `library` (types movie and series, prefix `tt`). Two streams point to a
150 s test video served by the addon (H.264 MP4 and VP9 WebM, made with
ffmpeg). It logged every request to JSONL. It was exposed with Tailscale Funnel
on port 10000 under a random path prefix.

Poller: `datastoreMeta` every 10 s, `datastoreGet` only for changed IDs, at most
1 request per second. A change is visible in the logs between 0 and 10 s after
the cloud write. The `_mtime` of each item gives the exact cloud write time, so
delays below use `_mtime`, not the poll time.

Test accounts: one Stremio account for all client tests, a second Stremio
account for the library size test, one Trakt account, one Simkl account with a
Simkl developer app ("Server apps & services", OAuth V2 with PKCE, the same type
as Stremlist), one MDBList account with its API key. Credentials are in
`~/.config/stremlist-watch-tests/accounts.env` (mode 600) only.

### Setup deviations

- **Funnel public path not verified.** From tour itself, the public Funnel
  address failed the TLS handshake (a hairpin limit, probably). Both clients
  ran on tour and reached the addon through the tailnet name. The browser
  needed `--disable-features=LocalNetworkAccessChecks,...` because Chrome 154
  blocks a public page (`web.stremio.com`) from fetching a private address. A
  real Stremlist addon is public HTTPS, so this flag is a test artifact only.
- **Android TV API level.** The API 33 and 34 Android TV images exist only as
  32-bit x86. Stremio's x86 APK crashes at start on API 34:
  `dlopen failed: cannot locate symbol "__atomic_compare_exchange"` in
  `libstremio_core_kotlin.so`. The test therefore used API 36 x86_64, the only
  x86_64 Android TV image.
- **Emulator without audio.** The emulator ran with `-no-audio`. ExoPlayer
  then never reached the end of the video ("Player stuck playing without ending
  for 60000 ms"), and `timeWatched` kept growing past the duration. A natural
  end could not be tested on TV. TV tests used Back or Home after 75%.
- **System change.** The user `leo` was added to the `kvm` group (persistent),
  because the emulator could not use `/dev/kvm`.
- **Disk.** The disk was 93 to 97% full. The unusable API 34 image was removed
  again; the AVD data partition is 6 GB.

## T1: Stremio Web

### Source facts (stremio-core `main`)

- Addons receive `player` events on play/pause (`PausedChanged`), on unload of
  the player, and on `Ended`. `currentTime` is `time_offset` (the highest
  position), not the time really watched.
- The automatic watched flag is set in `TimeChanged` when
  `time_watched > duration * 0.7` (`WATCHED_THRESHOLD_COEF`). A seek does not
  add to `time_watched`. This path sends **no** addon event. It calls
  Stremio's own `send_watched` (rating "watched") instead.
- `library` events with `action=watched|unwatched` come only from manual marks
  (detail page, video list, player menu), with `videoId` lists of at most 100
  IDs per request.
- An item is watched when `timesWatched > 0` (`LibraryItem::watched`). An
  episode is watched when its bit is set in `state.watched`.
- During playback the client pushes the item every 180 s
  (`PUSH_TO_LIBRARY_EVERY`). The timer belongs to the player model, not to the
  Title, so the first push of a new Title can come earlier than 180 s.

### Results per scenario

Movies: S1 `tt0063350`, S2 `tt0032138`, S3 `tt0017136`, S4 `tt0031381`, S5 and S6
`tt0047478`, S10 `tt0063350` again. Episodes: `tt0944947` (Game of Thrones) and
`tt0903747` (Breaking Bad). Test video: 150,000 ms.

| Scenario                                                                    | Events received by the addon (in order)                                                                                  | Native state at the end                                                                                          | Delay from end of action to cloud write                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| S1 full play                                                                | `start` (currentTime 0, duration 0) at the click; `pause` and `stop` 149942/150000 at the end                            | `timesWatched` 0→1, `flaggedWatched` 1                                                                           | 0 s (`_mtime` = time of `stop`, 14:15:44.36)                               |
| S2 seek to 95% via the seek bar, close after 2 s                            | `start` 0/0; `start` 142445/150000 (the seek); `stop` 144746/150000                                                      | not watched, `timeWatched` 20005                                                                                 | 0 s (write at `stop`)                                                      |
| S3 real playback to 75.5%, close                                            | `start` 0/0; `stop` 113327/150000                                                                                        | watched, `timeWatched` 113327                                                                                    | 0 s                                                                        |
| S4 real playback to 60.3%, close                                            | `start` 0/0; `stop` 90488/150000                                                                                         | not watched                                                                                                      | 0 s                                                                        |
| S5 manual "Mark as watched" (detail page)                                   | `library/movie/tt0047478/action=watched` only                                                                            | `timesWatched` 0→1, `flaggedWatched` stays 0                                                                     | 0 s                                                                        |
| S6 manual "Mark as unwatched"                                               | `library/movie/tt0047478/action=unwatched` only                                                                          | `timesWatched` 1→0                                                                                               | 0 s                                                                        |
| S7 episode 1:1 full play                                                    | `start`; `pause`, `stop` 149981/150000 at the end. Binge mode then started 1:2 and 1:3 by itself (`start` currentTime 1) | bit of 1:1 set; 1:2 later set by the 180 s push **before** its `stop`                                            | 0 s for 1:1; for 1:2 the bit was in the cloud 28 s before the `stop` event |
| S8 manual mark of one episode (1:5)                                         | `library/series/tt0944947/action=watched&videoId=tt0944947:1:5`                                                          | bit of 1:5 set                                                                                                   | 0 s                                                                        |
| S9 "Mark rest as watched" (the web UI's season mark) on 1:1 of Breaking Bad | one request, `videoId=tt0903747:1:1,...,tt0903747:1:7`                                                                   | bits of 1:1 to 1:7 set; `timesWatched` stays 0                                                                   | 0 s                                                                        |
| S10 replay of the watched S1 movie to the end                               | `start` 0/150000; `pause`, `stop` 149978/150000                                                                          | no change of watched state: `timesWatched` stays 1, `flaggedWatched` stays 1, only `timeWatched` grows to 300000 | 0 s                                                                        |

"0 s" means that the item `_mtime` is within 20 ms of the event time. The client
sends the event and the cloud write at the same moment. The two requests are
independent, so a server that reads the native state at once when an event
arrives can race the write (not measured).

### Verdict table, approach (a) versus approach (c)

(a): on each `player` `stop`/`pause` or `library` event, read the native state
and compare with the last known state. (c): watched if `currentTime/duration >= 0.8`
on `stop`.

| Scenario | Native (reference)                     | (a)                                       | (c)                                  |
| -------- | -------------------------------------- | ----------------------------------------- | ------------------------------------ |
| S1       | watched                                | correct                                   | correct (0.9996)                     |
| S2       | not watched                            | correct                                   | **wrong**: 0.965, false "watched"    |
| S3       | watched                                | correct                                   | **wrong**: 0.755, missed             |
| S4       | not watched                            | correct                                   | correct (0.603)                      |
| S5       | watched                                | correct (`library` event)                 | **wrong**: no `player` event, missed |
| S6       | unwatched (no Provider change by rule) | correct (no action)                       | correct (no action)                  |
| S7       | episodes watched                       | correct (bit visible at or before `stop`) | correct (≥ 0.999)                    |
| S8       | episode watched                        | correct                                   | **wrong**: missed                    |
| S9       | 7 episodes watched                     | correct                                   | **wrong**: missed                    |
| S10      | no new watch                           | correct (no transition)                   | **wrong**: second play sent          |

### Episode bitfield

`state.watched` has the form `{anchorVideoId}:{anchorLength}:{base64(zlib(bits))}`.
Bit `i` is video `i` of the Cinemeta list sorted by season, then episode, then
release date (season 0 specials first). The decoder
(`harness/bitfield.ts`) gave exactly the expected episodes in every case:

- `tt0944947:1:1:56:eJxjYACBBgYYAAAFEACB` → 1:1 (index 55: 55 specials come first).
- `tt0944947:1:2:57:...` → 1:1, 1:2.
- `tt0944947:1:5:60:...` → 1:1, 1:2, 1:5 (after S8).
- `tt0903747:1:7:12:...` → 1:1 to 1:7 (after S9).
- After the TV tests: 1:1, 1:2, 1:4, 1:5, 1:6.

The anchor lets a reader shift the bits when Cinemeta adds videos before the
anchor. A reader that sorts the list differently, or that ignores season 0,
decodes the wrong episodes. A movie has `watched` = `undefined:1:eJwDAAAAAAE=`
after an automatic watch; for movies, read `timesWatched`, not this field.

## T2: Android TV and other clients without events

### Android TV 1.10.4 (runtime)

- **Events:** none. During 6 sessions the addon received only `stream`
  requests and media range requests. No `player` or `library` path arrived.
  Static check: `libstremio_core_kotlin.so` (identical in TV 1.10.4 and mobile
  2.3.2, MD5 `2e296a95a116319ad185ec0bacc066d1`) contains no `libraryRemove`,
  `currentTime` or `unwatched` string. The web core contains them.
- **Cloud cadence during playback:** a push at playback start (within 1 s),
  then every 90 s: 15:07:53, 15:09:23, 15:10:53; 15:13:31, 15:15:01;
  15:16:33, 15:18:03; 15:21:13, 15:22:43; 15:26:56, 15:28:26, 15:29:56.
  This is shorter than the 180 s of the core source. Unverified on a real
  device.
- **Delay from the 70% crossing to the cloud while playback continues:** 75 s
  in two cases (crossing at about 105 s of playback, next 90 s push).
- **Back from the player (TV-S3):** push at once (watched, `_mtime` 15:15:32.57,
  Back at 15:15:33.19 in the log, which includes the adb delay). In TV-S7 the
  first Back did not leave the player, and the watched bit came with the next
  90 s push.
- **Home (app in background, TV-BG):** push at once (`_mtime` equals the key
  press time).
- **Manual episode mark (TV-S8, eye button on the episode's stream page):**
  push at once; bitfield bit of 1:4 set; no `library` event.
- **Force-stop at about 75% (TV-KILL):** the last push was the 90 s one
  (`timeWatched` 89489, not watched). Nothing more reached the cloud, also after
  a relaunch and 8 minutes. The watched crossing was lost on the device too.
- **No manual "Mark as watched" for movies** on TV 1.10.4: the movie detail page
  has no eye button, and the board menu offers only "Details" and "Clear
  Progress". Series and episodes have one. S5 is not possible on this client.
- Sign-in used the `link.stremio.com` code page. No CAPTCHA.

### Other clients (static only, unverified at runtime)

- **Android mobile 2.3.2:** same core library as TV 1.10.4, so no events
  expected.
- **Desktop Linux 4.4.168:** the shell loads `https://app.strem.io/shell-v4.4/`,
  an older JavaScript web app (`blob.js`, 6 MB) that has no `libraryRemove` or
  `action=start` string. Runtime test skipped: the `.deb` needs system Qt
  packages through apt, over the 30-minute limit.

### Recommended fallback

Poll `datastoreMeta` per linked Account, then `datastoreGet` only for IDs whose
`mtime` changed, and compare `timesWatched` (movies) and the decoded bitfield
(episodes) with the last known state. For clients without events, the best
case native latency is 0 to 90 s (Android TV) or 0 to 180 s (core default)
plus the poll interval. A force-stop loses the watch for good, so no design can
recover it. Web clients can use the events to read sooner, but the poll is
still needed for TV, mobile and desktop.

## T3: Stremio's native Trakt integration

| Step                                         | `getUser.trakt`                                                 | Addon collection                                                                                                                                                                     |
| -------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Before                                       | `{}`                                                            | 8 addons, no Trakt                                                                                                                                                                   |
| Just after "Authenticate" on Trakt           | `{created_at, expires_in: 604800, access_token, refresh_token}` | unchanged                                                                                                                                                                            |
| After a Stremio Web reload                   | same                                                            | new addon `org.trakt.13517481`, name "Trakt Integration", resources `["catalog"]`, transport `https://www.strem.io/trakt/addon/.../manifest.json`, flags not official, not protected |
| After "Log out" of Trakt in Stremio settings | `{}`                                                            | Trakt addon removed at once (before any reload)                                                                                                                                      |

- The Trakt authorization went through `trakt.tv/oauth/consent` with Stremio's
  client ID and redirect `https://www.strem.io/trakt/auth_cb`. A new Trakt
  account must first finish a profile page (name, birthday, country).
- **Scrobble of a full movie (Sunset Boulevard, natural end at 15:35:03):**
  one history entry "Today at 3:35 PM" on the Trakt account. It was there at the
  first check, about 3 minutes later. The movie page showed one play only.
- **Episode closed at 98% (Breaking Bad 2:1):** no history entry. Trakt showed
  "Now Playing, 44m left", which is a paused scrobble. The core sends
  `TraktPaused` on player unload and the final scrobble only on `Ended`. So the
  native state says watched, but Stremio's Trakt does not.
- **Duplicate check: unverified.** Stremlist writes `POST /sync/history` with
  `{movies: [{ids}]}` and no `watched_at` (`apps/backend/src/providers/trakt/actions.ts`).
  No Trakt test app could be made (see "Blocked steps"), and the new Trakt web
  app has no "watch again" control on the movie page.
- Detection rule for a later design: `getUser.trakt.access_token` present, or
  an addon whose `manifest.id` starts with `org.trakt.`. The first signal is
  immediate; the second appears only after a client reloads.

## R: real-API ramps

All steps were open-loop (requests sent on a fixed schedule). Stop rules:
first 429, repeated 5xx (3 in a step), or p95 above twice the p95 of step 1.

### R1 api.strem.io (test account, from tour)

`datastoreMeta` (library of about 10 items), 2 min per step:

| Rate | Sent | p50 ms | p95 ms | Max ms | Codes      |
| ---: | ---: | -----: | -----: | -----: | ---------- |
|  1/s |  120 |     32 |     60 |    117 | 200 × 120  |
|  2/s |  240 |     34 |     58 |    160 | 200 × 240  |
|  5/s |  600 |     33 |     51 |    111 | 200 × 600  |
| 10/s | 1200 |     31 |     49 |    521 | 200 × 1200 |
| 20/s | 2400 |     29 |     49 |    196 | 200 × 2400 |

`datastoreGet` (3 IDs):

|                                     Rate | Sent | p50 ms | p95 ms | Max ms | Codes                                                                                     |
| ---------------------------------------: | ---: | -----: | -----: | -----: | ----------------------------------------------------------------------------------------- |
|                                      1/s |  120 |     40 |    118 |    493 | 200 × 120                                                                                 |
|                                      2/s |  240 |     41 |    101 |    330 | 200 × 240                                                                                 |
|                                      5/s |  600 |     53 |     98 |    452 | 200 × 600                                                                                 |
|                                     10/s | 1059 |     46 |    123 |   1161 | 200 × 1055, **502 × 4** (HTML error page, all within 0.3 s, 105 s into the step), stopped |
| 10/s (confirmation, 1 min, 31 min later) |  600 |     36 |     60 |    464 | 200 × 600                                                                                 |
|     20/s (2 min, after the confirmation) | 2400 |     28 |     44 |    387 | 200 × 2400                                                                                |

- No rate-limit header (`X-RateLimit-*`, `Retry-After`) appeared. Responses
  come through Cloudflare (`cf-ray` from CDG).
- One more `datastoreMeta` series ran 2 minutes before the ramp by mistake (I
  stopped it at the start of step 2): 129 requests, all 200.

Library size, second test account, 10 `datastoreMeta` and 5 `datastoreGet` of
100 IDs per size (bytes are uncompressed JSON; the wire is gzip):

| Items | `datastoreMeta` bytes | Meta p50 / max ms | `datastoreGet` 100 IDs bytes | Get p50 / max ms | `datastoreGet all:true` |
| ----: | --------------------: | ----------------- | ---------------------------: | ---------------- | ----------------------- |
|    50 |                 1,412 | 33 / 45           |            27,252 (50 items) | 34 / 62          | 27 KB, 33 ms            |
|   500 |                14,012 | 41 / 60           |                       54,502 | 37 / 54          | 273 KB, 38 ms           |
| 2,000 |                56,012 | 51 / 60           |                       54,502 | 32 / 33          | 1.09 MB, 120 ms         |

- `datastoreMeta` costs about 28 bytes per item.
- `datastorePut` of 100 items: 54 to 108 ms, all accepted.
- **Stremio has no delete.** The seeded items were "removed" with
  `removed: true`; `datastoreMeta` and `datastoreGet all:true` still list all
  2,000. The core syncs removed items for one year (`should_sync`). This is why
  the seed used the second account, not the main test account.

### R2 Trakt

**Blocked.** See "Blocked steps". The Trakt account exists, and Stremio's Trakt
integration works with it.

### R3 Simkl (one user, the test app)

| Step                            | Sent | p50 ms | p95 ms | Max ms | Codes     |
| ------------------------------- | ---: | -----: | -----: | -----: | --------- |
| `POST /sync/history` 1/s, 2 min |  120 |     40 |    133 |    745 | 201 × 120 |
| Brief exceed, 4/s for 2 s       |    8 |     51 |     76 |     76 | 201 × 8   |

- Headers: `X-RateLimit-Limit: 500` and `X-RateLimit-Remaining`, which drops
  by 1 for each authenticated request, GET and POST. The first requests had no
  counter headers. No `Retry-After`, no reset header.
- The counter did not reset in 59 minutes (381 at 14:52, 371 at 15:49). The
  window is longer than one hour (probably a day; unverified).
- Requests with the client ID only (no user token) carry no counter headers.
- No 429 at 4 POST/s, against the documented "1 POST per second".
- **The two-user test was not possible**, so "per user or per client_id" is
  not answered.
- Undo: `POST /sync/history/remove` with the 10 test movies returned 201.

### R4 MDBList (API key of the test account)

| Step                           | Sent | p50 ms | p95 ms | Max ms | Codes    |
| ------------------------------ | ---: | -----: | -----: | -----: | -------- |
| `POST /sync/watched` 1/s, 30 s |   30 |     56 |    111 |    132 | 200 × 30 |
| 2/s, 30 s                      |   60 |     45 |     64 |     69 | 200 × 60 |
| Burst 5/s, 4 s                 |   20 |     46 |     58 |     58 | 200 × 20 |

- Headers: `X-RateLimit-Limit: 1000`, `X-RateLimit-Remaining` (minus 1 per
  POST), `X-RateLimit-Reset: 1794441600` (2026-11-12 00:00 UTC). `/user` gives
  `plan: Free`, `api_requests: 1000`, `rate_limit: 1000`. No per-second limit
  was seen up to 5/s.
- The response separates `updated`, `history_only`, `skipped_no_date` and
  `not_found`.
- Undo: `POST /sync/watched/remove` with the 10 movies returned 200.

## Detailed answers

### 1. Approach (a) or (c)

Choose (a), with these rules:

- Read the native state after every `player` `stop` and `pause` and every
  `library` event. An automatic watch sends only `player` events.
- Wait a few seconds before the read, or read again once: the event and the
  cloud write leave the client at the same moment (race not measured).
- Detect movie watches by `timesWatched` going from 0 to more than 0, and
  episode watches by new bits in the decoded bitfield. Do not use
  `flaggedWatched` (a manual mark leaves it at 0), and do not use the
  series-level `timesWatched` (it counts automatic episode watches).
- A replay (S10) and an unmark (S6) do not create a transition. This matches
  the CONTEXT.md rule that Stremio's status is the only reference.
- The events only come from clients with the new core (Stremio Web 6.0.7
  here). They are a trigger to read sooner, not a complete source.
- The `player` and `library` resources must be in the installed manifest. Each
  event goes to the Addon URL, which contains the Account ID. Unverified: the
  cost of such requests at Stremlist's scale.

### 2. Does the native state always match the UI

In this run, yes: movie eye tooltips ("Mark as watched" or "Mark as unwatched"),
the "WATCHED" badges on episodes, the progress bar on 1:3, and the Android TV
check marks on E01 and E02 all matched the cloud. Traps:

- A series item has `timesWatched > 0` after any automatically watched
  episode, and Stremio Web then shows the series-level eye as watched. S9
  (season mark) left `timesWatched` at 0. Series-level state is not a reliable
  "series watched" signal.
- A force-stop on Android TV loses the watch on the device and in the cloud.
  UI and cloud agree, but neither shows what the user saw.
- Stremio's own Trakt scrobble can disagree with the native state (close at
  98%: native watched, Trakt only paused).

### 3. Android TV

No events. Cloud pushes every 90 s during playback and at once on Back, Home
and manual episode marks; a force-stop loses the last up to 90 s, including a
watched crossing. Recommended fallback: `datastoreMeta` polling per Account
(see T2).

### 4. Stremio's Trakt integration

Detectable from `getUser.trakt` (at once) and from the collection addon
`org.trakt.<id>` (after a client reload). Stremio's scrobble made one history
entry at a natural end, and none when the player closed before the end. The
duplicate question for a Stremlist write is unverified.

### 5. Simkl limit

Not answered (no second user). With one user: limit header 500, shared by GET
and POST, only on user-token requests, not reset within 59 minutes, no 429 at
4 POST/s.

### 6. Inputs for the load simulation

| API                            | Measured                                                                                                 | Limit signals seen                                                                    | Not measured                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `api.strem.io` `datastoreMeta` | p50 29 to 34 ms, p95 49 to 60 ms at 1 to 20/s; 28 bytes per library item; p50 51 ms at 2,000 items       | none; no 429 at 20/s from one IP and one account                                      | more than 20/s; many accounts; calls from Vercel `fra1`             |
| `api.strem.io` `datastoreGet`  | p50 28 to 53 ms, p95 44 to 123 ms at 1 to 20/s; 100 items about 54 KB; all 2,000 items 1.09 MB in 120 ms | one burst of 4 × 502 at 10/s, not repeated in 3,000 later requests                    | same                                                                |
| Client push cadence            | Web: at stop/close, 180 s timer; Android TV: 90 s, at Back and Home                                      |                                                                                       | real TV and phone hardware                                          |
| Simkl                          | p50 40 ms, p95 133 ms at 1 POST/s                                                                        | `X-RateLimit-Limit: 500`, window over 1 hour                                          | per client_id behavior; 429 shape                                   |
| MDBList                        | p50 45 to 56 ms, p95 58 to 111 ms                                                                        | 1,000 requests per day per user on the free plan, reset 00:00 UTC; each write costs 1 | OAuth-token quota (Stremlist uses OAuth, the test used the API key) |
| Trakt                          | nothing                                                                                                  |                                                                                       | everything (blocked)                                                |

Example for the simulation (arithmetic, not measured): polling every Account
every 5 minutes at 20 requests per second covers 6,000 Accounts.

## Blocked steps

- **Trakt OAuth test app (R2, T3 duplicate check):** `developer.trakt.tv` says
  "Link GitHub once to create apps". Linking the owner's GitHub account to a
  test account was outside the authorization for this run. Owner action
  needed: link a GitHub account, or give a test GitHub account.
- **Second Simkl user (R3):** Simkl answered "This Email is already registered"
  for `+tag`, dot and `googlemail.com` aliases of the owner's Gmail (it
  normalizes Gmail addresses, so they map to the owner's own Simkl account),
  and "Please enter a correct Email" for an `example.com` address. Account 1
  uses an alias of the owner's second Gmail inbox. A public disposable inbox
  was not used. Owner action needed: a mailbox on another domain.
- **Natural end on Android TV:** see "Emulator without audio".
- **Desktop Linux runtime:** skipped (system packages, time limit).
- No CAPTCHA or bot check appeared anywhere.

## State left in place

- Test accounts: two Stremio accounts, one Trakt account (Stremio's Trakt
  connection removed), one Simkl account and its developer app, one MDBList
  account and API key. The main Stremio test account still has the test addon
  installed; its URL no longer answers (Funnel and server stopped).
- AVD `wt-androidtv-36` with Stremio 1.10.4 installed and signed in (the
  emulator is stopped). Start it with
  `sg kvm -c "~/Android/Sdk/emulator/emulator -avd wt-androidtv-36"`.
- Stopped: Funnel on port 10000, addon server, poller, OAuth callback listener,
  Xvfb, browser sessions.

## Raw data

All under `/tmp/claude-1000/watch-tracking-tests/` (tmpfs: lost at reboot).

- `data/addon-requests.jsonl`: every request to the test addon.
- `data/native-state.jsonl`: poller output (full LibraryItems per change).
- `data/markers.jsonl`: scenario start and end times.
- `data/ramp-r1-*.jsonl`, `data/r1-library-size.jsonl`: R1.
- `data/ramp-r3-simkl-*.jsonl`, `data/ramp-r4-mdblist*.jsonl`: R3, R4.
- `data/t3-snapshot-*.json`: T3 snapshots (tokens redacted).
- `data/*.png`: screenshots (web, TV, Simkl, Trakt).
- `harness/`: addon, poller, ramp, bitfield decoder and helper scripts.
- `downloads/core/`: stremio-core source files read for this report.
