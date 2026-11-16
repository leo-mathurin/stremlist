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

| Provider     | Status page                          | Components         |
| ------------ | ------------------------------------ | ------------------ |
| Trakt        | `status.trakt.tv` (UptimeRobot)      | The "API" group    |
| Simkl        | `status.simkl.com` (UptimeRobot)     | `API.simkl.com`    |
| MDBList      | `status.mdblist.com` (Better Stack)  | `api.mdblist.com`  |
| SensCritique | `status.senscritique.com` (Instatus) | `senscritique.com` |

Letterboxd, IMDb and JustWatch publish none. When a page says a component is
down, the outage starts at once and lasts while the page says so, even when
Stremlist's own probe works. A degraded component is not an outage. A page
that does not answer or whose format changed gives no signal. The UptimeRobot
endpoint (`/api/getMonitorList/<page>`) is the one the page itself loads, not
a documented API, so it can change. A status page never fails `/monitor` or a
heartbeat.

A Better Stack heartbeat (`BETTERSTACK_HEARTBEAT_URL_<PROVIDER>`) is optional.
When it is set, every failed probe alerts, as before.

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

## Operations

- Call `/monitor` at least every 15 minutes, so that two failed probes come
  well within the one-hour limit. An outage then shows after two calls.
- Nothing else needs to change for the release: probes for Trakt, Simkl and
  MDBList use the client IDs that production already has.
- To see the state, read `provider_outages` in the Supabase dashboard
  (read-only). Do not edit it by hand: the next probe sets it again.
