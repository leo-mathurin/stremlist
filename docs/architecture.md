# Architecture

Vocabulary lives in [CONTEXT.md](../CONTEXT.md). The decision IDs below preserve
the `ADR 0001`–`ADR 0008` references in source comments.

## ADR 0001: Private Account IDs

Generated `sl_…` Account IDs make the Addon URL the sole credential without
coupling identity to a Provider. Guessable `ur…` Legacy aliases read public Lists
only. Upgrading copies configuration to a new private Account; the old install
keeps working but its configure page becomes read-only and never reveals the
private Addon URL. Account writes and the copy are transactional.

## ADR 0002: IMDb Title IDs

Every adapter resolves entries to `tt…` IDs for compatibility with Stremio's
metadata, stream and subtitle addons. Unresolved entries are hidden and retried
on later refreshes, never cached as permanent failures. The shared pipeline in
`apps/backend/src/services/lists.ts` resolves IDs, enriches metadata and caches
Catalogs, so Providers share the same Title identity.

## ADR 0003: Actions open a page

Stream entries use `externalUrl` to an Action page with an explicit, repeatable
intent. Playing a confirmation clip would alter Stremio's watched state,
scrobbling, Continue Watching and last-used stream. Actions are off by default;
stream responses are uncached. LG/Samsung clients cannot open these URLs.

## ADR 0004: Previews leave saved Catalogs untouched

Previews read Providers through the shared pipeline without writing Catalog
caches or sync statuses. They may populate the shared Title ID map. In-memory
reads last five minutes (30 seconds if entries remain unchecked); private reads
are isolated by Account and authorization version. Reconnecting invalidates
that scope; routine token refreshes retain it. Preview shuffle can differ from
the saved Catalog.

## ADR 0005: Sync status is per Source list

`list_sync_status` records success/failure and the start of each failure run in
one RPC per shared refresh; a status-write failure never fails the Catalog.
The UI polls only while a saved List waits for its first refresh. A merged List
shows a Source list's problem, otherwise its oldest success. Disconnect removes
the affected statuses transactionally. Refused Connection tokens mark
`needs_renewal_since`; working authorization, refresh or private reads clear it.

## ADR 0006: Merged Lists cache each Source list

Each Source list keeps its own cache and freshness; reads merge by IMDb ID in
memory, retaining Simkl attribution. One failed or disconnected Source list
does not hide the others. A single-source List keeps its List ID as cache key.
Merged Lists allow date-added sorting only when every Source list supplies dates;
`sourceHasAddedDates` must match adapters. Shared rules enforce five Source lists
per List, 20 per Account and no duplicate Source list in an Account. Saves remove
unused caches and stale clients cannot silently overwrite merged Sources.

## ADR 0007: Detections compare complete Synchronizations

Only successful reads that reach the last page are compared. The first is a
Baseline, never a wave of new Titles. Entry keys use the Provider's stable
`resolutionKey`, else IMDb ID, else normalized title/year. Unresolved entries
participate and retain their Detection date when resolved. Returning entries
retain their first Detection; Baseline Titles never become new through another
entry key. History belongs to Account and Source list, surviving List removal.
Private history belongs to the Connection's Provider user and creation time;
disconnect or switching users invalidates it. "New titles" deduplicates Titles
across current Sources by earliest Detection and reads cached metadata only.
Detections are recorded even when the Catalog is disabled.

## ADR 0008: Detection history lives in R2

One JSON object per Account/Source list avoids millions of Postgres entry rows
that exceeded the database storage budget. ETag-conditional writes retry on
conflicts; reads older than the recorded synchronization are refused. Every
complete read advances the stored timestamp, even when its entries are unchanged,
so a slower earlier read cannot record titles that the newer read no longer saw.
Active Sources survive the bucket's 30-day lifecycle. Expired histories start a
new Baseline. Removed entries are forgotten after
180 days. Private objects live under `connections/<account>/<provider>/history/`;
other histories use `history/<account>/`. Disconnect and Account deletion clean
up the relevant R2 prefixes.

## Provider constraints

Adapters live in `apps/backend/src/providers/`. Prefer anonymous public reads;
use encrypted OAuth Connections for private Sources and Actions. Refresh leases
serialize rotating tokens, and refreshes retain the original redirect URI.
Private caches belong to a stable authorization version: token refresh preserves
it, while reconnect or disconnect invalidates cached data from the old grant.
`DISABLED_PROVIDERS` blocks all outbound access to those Providers, including ID
lookups and Actions, while Lists continue serving their last cached Catalog.

| Provider     | Read path and constraints                                                                                                                                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IMDb         | Anonymous unofficial GraphQL; public watchlists, lists and charts; no Actions                                                                                                                                                                                                 |
| Trakt        | Official API; client ID for public Sources, OAuth/PKCE for private Sources and Actions. Public reads fall back to client ID when a Connection fails. OAuth uses `auth.trakt.tv`. Free accounts have one community-app authorization slot. Up Next lists series, not episodes. |
| Simkl        | OAuth V2/PKCE; check `/sync/activities` before reading unchanged libraries. Custom lists require PRO/VIP. Retain "More on Simkl" attribution on Catalog items.                                                                                                                |
| MDBList      | OAuth using the connected user's quota; reads its own lists/imports, never acts as another Provider's proxy                                                                                                                                                                   |
| JustWatch    | Anonymous unofficial GraphQL for shared/editorial lists; no main Watchlist or Actions. Missing IDs use exact lookups/TMDB, without fuzzy title-only matches.                                                                                                                  |
| SensCritique | Anonymous unofficial GraphQL; resolve through Wikidata, JustWatch, then TMDB only with director/runtime agreement                                                                                                                                                             |
| Letterboxd   | Adapter unavailable pending official API access; suggest importing through MDBList                                                                                                                                                                                            |
