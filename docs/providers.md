# Providers

How Stremlist reads each Provider, and why that method. Vocabulary: [`CONTEXT.md`](../CONTEXT.md). Decisions that shape every Provider:

- Every Provider goes through the same pipeline (`apps/backend/src/services/lists.ts`): the adapter reads the Source list, the shared ID resolver turns entries into IMDb IDs ([ADR 0002](adr/0002-titles-are-imdb-ids-only.md)), the shared enrichment step fills the metadata (IMDb in batches, Cinemeta as fallback), and the Catalog is cached in R2.
- Public first: a Source list that can be read without login never asks for one. OAuth (authorization code with PKCE, on the configure page) only where a Provider has no public access or for Actions. Passwords and pasted session tokens are never stored.
- Tokens of a Connection are encrypted (AES-256-GCM) and refreshed by one process at a time (lease), because Trakt refresh tokens are single-use and Simkl cancels the previous access token on refresh. Each Connection keeps the redirect URI of its authorization, and refreshes send that same URI (Trakt checks it).
- Every refresh records the Sync status of its List (`list_sync_status`, ADR 0004). When a Provider refuses a read through a Connection (`needs_connection` with a Connection, or a token refresh that fails), the Connection gets `needs_renewal_since` and the configure page asks to connect again. A new authorization or a working read clears it, and a new authorization reads that Provider's Lists again at once.
- Kill switch: `DISABLED_PROVIDERS=trakt,justwatch` (one variable for all Providers, no deploy needed). A turned-off Provider gets no request at all: no Source list read, no ID resolution strategy that calls it (for example the JustWatch lookups of SensCritique), no Connection, no listing of a Connection's lists, no Action. Its Lists serve the last cached Catalog.
- The configure page shows each Provider's official mark, unaltered, only to say that Stremlist works with it. The footer names the logos as trademarks of their owners, with the attribution that IMDb's brand rules ask for.
- Actions open a Stremlist page, never a video clip ([ADR 0003](adr/0003-actions-open-a-page-not-a-clip.md)).

Every access method below was compared with all the others we found (official API, OAuth, client ID only, unofficial GraphQL, HTML scraping, RSS, exports, MDBList and StremThru as aggregators, browser relay, user cookies or tokens). Research and tests date from 2026-10-05 and 2026-10-06.

## IMDb

- **Method:** IMDb's unofficial GraphQL API (`api.graphql.imdb.com`, with the `x-imdb-client-name` header). Public watchlists (`ur…`, or a `p.` handle resolved to `ur…`), public lists (`ls…`) and the built-in charts.
- **Why:** it is the only way to read user lists. The official IMDb API (AWS Data Exchange, from $150k a year) has no user lists; RSS is retired; HTML pages are behind an AWS WAF challenge.
- **Actions:** none. The only write path is the user's IMDb session cookies.
- **Risk:** each response carries a "non-private use not allowed" disclaimer. Accepted, as before.

## Trakt (STR-17)

- **Method:** official API `api.trakt.tv`. With a Connection (OAuth with PKCE; new apps have no client secret), every read uses the user's token and quota. Without one, public watchlists and lists are read with the client ID only. Every OAuth call (authorize, token, revoke) goes to `auth.trakt.tv`, the host that Trakt's current OAuth documentation gives, not the API host.
- **Why both:** since 2026-07-22 a free Trakt account can authorize only one community app, and Stremio's own Trakt sync probably uses it. Public reads keep Trakt working for those users and for lists curated by others. Scraping, MDBList and StremThru as proxies, and reusing Stremio's token are forbidden or dead.
- **Source lists:** watchlist and lists of any user, official lists, trending, popular, anticipated; with a Connection also recommendations, Up Next, history and collection. Up Next lists the series, not the next episode: a Stremio catalog shows series, and Stremio opens the right episode from Continue Watching.
- **One app on free accounts:** the configure page says so next to Connect, and suggests public links for users whose only app slot is Stremio's own Trakt sync.
- **Actions:** watchlist, watched (movies and episodes), rating.
- **Limits:** 500 GET every 5 minutes for the whole app without a token, per user with a token; writes 1 per second; pagination is mandatory (250 per page). Free accounts: 250 watchlist items, 5 lists.
- **Policy:** the API Use Policy (2026-09-22) allows managing a user's watchlist from a third-party app and forbids relaying data to other services and apps that promote piracy. Trakt support was told about the integration on 2026-10-06.

## Simkl (STR-54)

- **Method:** OAuth V2 "server app" (authorization code with PKCE and client secret), scopes `media:read media:write`. No user data is public, so there is no other method.
- **Sync rule:** each refresh first checks `/sync/activities` and reads items only when something changed. Simkl suspends client IDs that poll without this check.
- **Source lists:** plan to watch, watching, completed, on hold, dropped, and history (everything watched, from the same library read); custom lists for PRO and VIP accounts only.
- **Link back:** each catalog item ends its description with "More on Simkl" and the item's Simkl page. Stremio shows meta links only for the addon that gives the metadata (Cinemeta), so the description is the visible place.
- **Actions:** watchlist (plan to watch), watched, rating.
- **Policy:** free under $150 of revenue a month; items must link back to Simkl.

## MDBList (STR-56)

- **Method:** OAuth (confidential web app). Every request counts on the user's own MDBList quota (free: 1,000 a day); Stremlist has no app-level key.
- **Source lists:** the user's lists, public lists of other users, the MDBList watchlist, and external lists that MDBList imports from IMDb, Letterboxd, JustWatch and others.
- **Not a proxy:** MDBList is never used to read another Provider (Trakt blocks it since September 2026; Simkl and SensCritique are not supported).
- **Actions:** watchlist, watched, rating, on MDBList data only.

## JustWatch (STR-18)

- **Method:** JustWatch's unofficial GraphQL API, anonymous, for custom lists shared by link (`justwatch.com/shared?id=tl-us-…`) and JustWatch's own editorial lists.
- **ID resolution:** most titles carry an IMDb ID. The others go through TMDB, then a new JustWatch lookup on later refreshes, because JustWatch adds missing IMDb IDs within days. A title and year search is not used: about 6% of titles lack an ID at first, and a fuzzy match could add the wrong Title.
- **Verified 2026-10-06:** every custom list is UNLISTED (the server rejects PRIVATE and PUBLIC) and reads without auth, with IMDb IDs on each title. List IDs are random UUIDs.
- **Not supported:** the main JustWatch Watchlist and Actions. Both need the user's Firebase token copied from the browser, which expires and breaks the terms.
- **Risk:** the terms forbid scraping and the schema has no documentation. Traffic stays low (long cache, rate limiter) and queries are pinned in tests.

## SensCritique (STR-55)

- **Method:** SensCritique's unofficial GraphQL API (`apollo.senscritique.com`), anonymous: a user's wishlist ("envies") and lists, films and series only.
- **ID resolution:** products have no IMDb or TMDB ID. In order: Wikidata property P10100 (exact, one batch query), the product's JustWatch link (exact, one request per product, skipped while JustWatch is turned off), then a TMDB title and year search that is accepted only when the director or the runtime also agrees. Anything else stays an Unresolved entry and is retried later.
- **Actions:** none.

## Letterboxd (STR-20): on hold

- **Chosen method:** the official API (`api.letterboxd.com`), the only one that agrees with the terms and supports Actions. Access requested on 2026-10-06; no work until Letterboxd answers.
- **Rejected:** HTML scraping (terms §6.11, Cloudflare), the public StremThru instance (someone else's credentials), RSS (diary only), data export (manual).
- **Meanwhile:** the configure page suggests importing a Letterboxd list into MDBList and adding the MDBList list.

## Dropped

- **TV Time:** shut down on 2026-07-15; user data deleted.
- **Showly:** a Trakt app (data syncs to Trakt). Use the Trakt source.
