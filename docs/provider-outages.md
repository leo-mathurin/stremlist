# Provider outages

When a Provider is down, the configure page shows one banner that names every
Provider with an outage. Each affected row in the Providers list says "Having
problems". When the outage ends, the banner goes away and a short note says
that the Provider works again. Lists keep their last Catalog in Stremio during
the outage, as for any failed read.

## How an outage is found

The external scheduler calls `GET /monitor` (with `CRON_SECRET`). Each call
probes every Provider that Stremlist can check:

| Provider     | Probe                                                           | Needs               |
| ------------ | --------------------------------------------------------------- | ------------------- |
| IMDb         | Reads `MONITOR_IMDB_USER_ID`                                    | The reference       |
| Trakt        | Reads the Trending chart, or `MONITOR_TRAKT_REF`                | `TRAKT_CLIENT_ID`   |
| Simkl        | `GET /search/id` on the Simkl API                               | `SIMKL_CLIENT_ID`   |
| MDBList      | `GET /lists/top` on the MDBList API; any answer below 500 is up | `MDBLIST_CLIENT_ID` |
| JustWatch    | Reads `MONITOR_JUSTWATCH_REF`                                   | The reference       |
| SensCritique | Reads `MONITOR_SENSCRITIQUE_REF`                                | The reference       |
| Letterboxd   | Reads the official Top 500 list, or `MONITOR_LETTERBOXD_REF`    | Nothing             |

`/monitor` also reads the official status pages of four Providers, for the
part that Stremlist reads:

| Provider     | Status page                            | Components         |
| ------------ | -------------------------------------- | ------------------ |
| Trakt        | `status.trakt.tv` (UptimeRobot)        | The "API" group    |
| Simkl        | `status.simkl.com` (UptimeRobot)       | `API.simkl.com`    |
| MDBList      | `status.mdblist.com` (Better Stack)    | `api.mdblist.com`  |
| SensCritique | `senscritique.instatus.com` (Instatus) | `senscritique.com` |

Letterboxd, IMDb and JustWatch publish none. When a page says a component is
down, the outage starts at once and lasts while the page says so, even when
Stremlist's own probe works. A degraded component is not an outage. A page
that does not answer or whose format changed gives no signal. The UptimeRobot
endpoint (`/api/getMonitorList/<page>`) is the one the page itself loads, not
a documented API, so it can change. A status page never fails `/monitor` or a
heartbeat. SensCritique's page is read on its Instatus domain:
`status.senscritique.com` answers HTTP 403 with a Vercel bot challenge.

A Better Stack heartbeat (`BETTERSTACK_HEARTBEAT_URL_<PROVIDER>`) is optional.
When it is set, every failed probe alerts. The list checks below send the
pings.

A failed probe also makes `/monitor` answer HTTP 502, except when the Provider
is turned off or halted (`unavailable: true` in its result). Then only its
heartbeat alerts, so a Letterboxd halt gives one alert, not two.

Only some failures count toward an outage: a server error (5xx), a timeout, or
a network failure, also when an adapter wraps it in an "unavailable" error.
These do not count, so they never show a banner:

- a rate limit (429) or a busy Letterboxd queue,
- a private or missing monitor list,
- a refused Connection or a Provider app that is not configured,
- an answer that Stremlist cannot read, or a bug in Stremlist,
- an "unavailable" error with no Provider failure behind it, such as an
  unreadable Letterboxd gate or cache,
- a Provider that is unavailable (kill switch or Letterboxd halt). Its row
  already says "Temporarily unavailable".

The table `provider_outages` (migration `20261116120000_provider_outages.sql`)
keeps one row per Provider. Two failed probes in a row start an outage, or one
"down" from the status page. The next successful probe ends it, or the status
page saying "up" when no probe decides. A failure that does not count changes
nothing.

`GET /providers` gives `outageSince` for each Provider. It is null when the
Provider has no outage, when it is unavailable, when the last counted probe is
more than one hour old (the monitor stopped), or when the table cannot be read.
The configure page asks again every 2 minutes while it is visible. A failed
request keeps the last answer.

## List checks

A probe reads one Source list per Provider. It does not find a failure of
one list type, such as Trakt ratings or IMDb charts, and it does not find a
read that gives no error but too few Titles. The list checks find these
failures. They alert in Better Stack and name the list type. They never
change the outage state or the banner: only the probe does that.

A list type is one IMDb chart, one fixed Source list (`trakt:me/history`,
`trakt:trending`) or one stored reference form with its variable parts in
braces (`trakt:users/{user}/watchlist`). `listTypeOf` in
`packages/shared/src/providers.ts` gives the list type of a reference.

At most once in 10 minutes, one `/monitor` call starts the list checks after
its answer. The table `monitor_runs` (migration
`20261117120000_monitor_runs.sql`) gives this run to one call only, because
Better Stack calls from 4 regions and serverless instances share no memory.
The other calls only probe. A run does these steps:

1. It reads one **canary** for each list type
   (`apps/backend/src/services/monitor/canaries.ts`). A canary reads a Source
   list through the Provider adapter, without the cache, and fails when the
   read fails or gives fewer entries than its minimum. Public types read a
   built-in reference. Types that need a Connection read through the
   Connections of the monitor Account (`MONITOR_ACCOUNT_ID`). Types with
   variable parts that have no built-in reference are read only when
   `MONITOR_CANARY_REFS` gives one. A type that cannot be read is "not
   covered", which is never a failure. The MDBList canaries are read at most
   once an hour (row `list-checks:mdblist` of `monitor_runs`), because the
   monitor Account uses its owner's MDBList quota of 1,000 requests a day.
   Between two reads, a run keeps the last MDBList results, so the heartbeat
   stays failed or healthy until the next read.
2. It reads `list_sync_status`. A list type alarms when at least 3 of its
   Source lists fail as "unavailable", or at least 2 that are half or more of
   that type. A public Source list in several Lists counts once. Only Source
   lists refreshed in the last 24 hours count. Other
   reasons (private, not found, a lost Connection) are the user's problems
   and never alarm.
3. It sends one ping per heartbeat URL. The ping fails when the probe, a
   canary or the alarm of one of its Providers failed. The body has one line
   per failure, for example
   `imdb:ls/list (ls055592025): 12 entries, expected at least 80`. A canary
   that fails for a timeout, a server error or a network failure fails the
   ping only when its previous read failed too (the run before, or the read
   an hour before for MDBList). Until then, its result is `pending`. Several
   Providers can use the same URL. A URL whose Providers nothing read gets
   no ping, so Better Stack alerts when the checks stop. A read that lost
   its connection to a reset (`ECONNRESET`), also behind an adapter error,
   is neither a failure nor a success: when every read of a Provider gets
   a reset and nothing else on its URL failed, the URL gets no ping.

The answer of `/monitor` gives `listChecks.started` and `listChecks.last`:
the last run, with each canary result (`ok`, `failed`, `skipped` or
`not_covered` with its reason), the alarms and the failures per Provider.

A unit test (`monitor-canaries.test.ts`) fails when a list type has no
canary and no written reason for none. When you add a list type, add its
entry to `CANARIES`.

Canaries read through these references by default:

| List type                                                                                      | Source list                                      |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `imdb:chart/*`                                                                                 | The chart                                        |
| `imdb:ls/list`                                                                                 | `ls055592025`                                    |
| `imdb:ur/watchlist`                                                                            | `ur195879360`                                    |
| `imdb:ur/ratings`                                                                              | `ur102185135/ratings`                            |
| `trakt:` charts (`trending`, `boxoffice`…)                                                     | The chart (needs `TRAKT_CLIENT_ID`)              |
| `justwatch:{list}`                                                                             | `tl-tu-12653`                                    |
| `senscritique:users/{user}/wishes`                                                             | `users/Sergent_Pepper/wishes`                    |
| `senscritique:lists/{id}`                                                                      | `lists/369869`                                   |
| `senscritique:users/{user}/done`, `rated`, `recommend`, `liked`                                | `users/Plume231/…`                               |
| `senscritique:users/{user}/current`                                                            | `users/kYrios/current`                           |
| `senscritique:users/{user}/done/{year}`                                                        | `users/Sergent_Pepper/done/2024`                 |
| `senscritique:` charts and `polls/{id}`                                                        | The chart, `polls/3996052`                       |
| `simkl:trending/*`, `simkl:dvd/releases`                                                       | The chart (Simkl's CDN)                          |
| `simkl:trending/{type}/genre/{slug}`                                                           | `trending/movies/genre/horror`                   |
| `letterboxd:users/{user}/lists/{slug}`                                                         | `users/official/lists/letterboxds-top-500-films` |
| `trakt:me/*`, `simkl:me/*`, `mdblist:me/*`, `mdblist:official/*`, `mdblist:recommended/rising` | The monitor Account's Connection                 |

The other types with variable parts (Trakt user lists, smart lists, MDBList
lists, Letterboxd member pages) need an entry in `MONITOR_CANARY_REFS`. Pick
a Source list that does not change much, and set its minimum to about 80% of
its size: `letterboxd:users/alice/diary=40`. For Trakt, pick small public
Source lists: Trakt public reads share an app quota of 500 requests in 5
minutes, and a user's history or collection can cost about 20.

The monitor Account is a normal Account. Connect it to Trakt, Simkl and
MDBList on the configure page, and keep Titles in each Source list that a
canary reads: an empty watchlist fails its canary.

### Production setup

Production uses this setup since 2026-11-17 (v2.8.0):

- **Heartbeats:** IMDb, Letterboxd, JustWatch and SensCritique each have
  their own heartbeat. Trakt, Simkl and MDBList share one heartbeat,
  "Stremlist Trakt, Simkl, MDBList probe", because the free Better Stack
  plan has 10 monitors and heartbeats in total.
- **Monitor Account:** `MONITOR_ACCOUNT_ID` names an Account that is
  connected to the owner's Trakt, Simkl and MDBList accounts. It has no
  Lists, no Stremio connection and no Actions, so it never writes to a
  Provider. Do not delete it, and do not disconnect its Connections.
- **Empty Source lists:** some lists of the owner's accounts are empty. In
  `MONITOR_CANARY_REFS`, their types have a minimum of 0, so their canaries
  alert only when the read fails. When such a list gets Titles, set its
  minimum back to about 80% of its size.
- **Trakt public users:** `MONITOR_CANARY_REFS` reads the watchlist,
  favorites, ratings and history of one public Trakt profile. Its history
  has more than 100 Titles, so a read that stops after the first page fails
  the canary. Public collections are not covered: one read costs about 44
  calls of the app quota.

## Operations

- Call `/monitor` at least every 15 minutes, so that two failed probes come
  well within the one-hour limit. An outage then shows after two calls.
- Set the heartbeat period to more than 20 minutes. The list checks ping
  every 10 to 20 minutes, from the first call after the 10 minutes.
- Nothing else needs to change for the release: probes for Trakt, Simkl and
  MDBList use the client IDs that production already has.
- To see the state, read `provider_outages` in the Supabase dashboard
  (read-only). Do not edit it by hand: the next probe sets it again.
