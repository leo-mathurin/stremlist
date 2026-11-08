# Public and share-link Letterboxd lists

Stremlist reads full public watchlist and list URLs, for example `https://letterboxd.com/member/watchlist/` and `https://letterboxd.com/member/list/list-name/`. A Letterboxd Connection is not required, and no credentials are stored (ADR 0001). Account Actions and lists visible only to the owner or to friends are not supported.

A member can share a non-public list by setting it to "Anyone with share link" on Letterboxd. Stremlist reads that list through its share URL (`https://letterboxd.com/member/list/list-name/share/<token>/`) or its `boxd.it` short link. A public `boxd.it` short link resolves to its canonical list too.

Stremlist also reads a member's other public pages as Source lists: watched films (`/member/films/`, including a rating filter such as `/member/films/rated/4.0-5.0/` as its own Source list), the diary (`/member/diary/`, a history Source list that keeps each Title once with its most recent watch date), and liked films (`/member/likes/films/`). Stremlist does not read the popular charts: Letterboxd's robots.txt disallows `/*/popular/this/*`, and their grid fragment (`/csi/…`) can answer with a challenge, which would halt every Letterboxd read. A rating filter is stored in Letterboxd's own form of the range (`4.0-5.0` becomes `4-5`), which its pagination links use. All of these are public pages; a private profile is not readable.

This adapter belongs to the multi-provider branch. It does not deploy that branch or migrate the current production database.

## Share links

The share token is a secret. Stremlist encrypts it with the Connection key (`CONNECTION_ENCRYPTION_KEY`, AES-256-GCM) before it becomes part of the stored Source list reference (`share/v1:…`). The configure page shows only "Shared list", never the token, the slug, or a clickable URL, and logs never print the reference. The page cache keys on a SHA-256 of the decrypted path, so two Accounts with the same share link share one cached page.

A `boxd.it` short link is followed once on the backend (in `validateSource`). A link that resolves to a film or a member, not a list or watchlist, is refused. When a share link is revoked (the list leaves "Anyone with share link" or is deleted), Letterboxd answers HTTP 404; Stremlist then clears the Catalog instead of serving the Titles it cached before, the same as a deleted or hidden public list.

## Reads and title IDs

The adapter reads anonymous HTML, with the Stremlist User-Agent and manual redirects. It requires explicit document closing tags and a positively closed empty grid, or the closed "No films yet" block of an empty watchlist or list, before accepting an empty page. It validates every page and its pagination before recording HTTP success or caching it, follows only the next numbered page of the same collection, deduplicates stable `film:…` IDs and stops at 100 pages. A capped read is incomplete and does not advance detection history. Watchlists use oldest-added order; ranked lists keep their page order.

IMDb resolution first uses exact [Wikidata Letterboxd IDs](https://www.wikidata.org/wiki/Property:P6127), by stable ID and then slug. Missing mappings use the film page's exact IMDb link. No title similarity match is used. Wikidata reads stay grouped in batches of 50; paced film pages are read one at a time. The resolver checks its soft budget between strategy batches. Failed and unattempted lookups stay deferred without a negative cache row. The existing shared `title_id_map` stores the result, so films in several lists do not need another lookup. Entries without an IMDb ID remain unresolved and are retried by the common resolver.

## Shared cache and request coordination

Parsed public pages live in R2 under `providers/letterboxd/pages-v1/`. They are shared between Accounts and remain fresh for six hours. Conditional writes give one worker the page lease. A manual Refresh now waits for an older in-process refresh to settle, then revalidates the pages. It does not join an ordinary cached read or wait for the six-hour expiry. Catalog metadata, stale fallback, sync status and detection history use the existing List pipeline.

The `public.letterboxd_gate` row in Postgres coordinates outbound requests across instances (`supabase/migrations/20261108120000_letterboxd_gate.sql`). R2 allows one write per second per object, which capped the previous R2 gate near 0.5 request/s. The gate is a token bucket:

- It refills at the target rate, `LETTERBOXD_MAX_RPS` (default 10 requests/s), and holds one second of tokens. Requests run in parallel.
- An interactive read (a new List, a Catalog with no cache to serve, a Refresh, a link check) reserves the next slot and waits for it, up to 10 seconds. A background read (a Catalog with a stale cache that is served if the read is refused) only takes a free token and never queues ahead of someone waiting. A refused read raises `LetterboxdBusyError` with the estimated wait.
- A request reserved more than one second ahead checks the gate again before it is sent, so a slowdown that started meanwhile stops it.
- Storage failure denies new sends.

A 429, or more than 20% failed reads over a minute (at least 20 reads), pauses sends for max(Retry-After, 60 s) and halves the rate, never below 0.33 request/s. The rate then climbs by 0.5 request/s per minute. Network errors, unusable collection HTML and timeouts while reading an HTTP 200 body are failed reads. Three slowdowns at the floor rate within 15 minutes, a 403, a challenge response header or a challenge document halt new outbound reads. A halted gate lets one probe request through every 30 minutes; a probe that succeeds resumes reads at the floor rate. A failed page never replaces a valid cached page with an empty result.

## Operation

`DISABLED_PROVIDERS=letterboxd` is the existing application kill switch. A halt makes Letterboxd unavailable in the same way: the configure page shows it as temporarily unavailable, new Letterboxd links are refused, and Lists keep their last Catalog with a sync note. The instance whose report halts the gate also reports to `BETTERSTACK_HEARTBEAT_URL_LETTERBOXD` (`/fail`) at once, and a successful probe pings it again to resolve the incident. A rate kept below half of `LETTERBOXD_MAX_RPS` for 30 minutes also reports a failure: Letterboxd keeps answering 429, so lower `LETTERBOXD_MAX_RPS`. `/monitor` probes Letterboxd's official Top 500 list (`users/official/lists/letterboxds-top-500-films`, five pages) on its schedule and reports the same slow state. Apply environment changes through a reviewed deployment. Cached Catalogs remain available through the common fallback.

Inspect the gate after a halt: `halt_reason` is `blocked` for a 403 or a challenge and `rate_limited` for repeated 429 responses at the floor rate. Check the cause before resetting it. The automatic probe resumes reads when Letterboxd accepts them again; to resume at once, run the reset statement in the table comment. Keep page and title-ID caches.

The previous lab recorded 32,197 valid pages over 30h23, with no detected 403/429/challenge. A body timeout stopped that campaign early. It did not complete 72 hours or prove a quota for 50k users. Evidence is in the private [lab report](https://github.com/leo-mathurin/stremlist-letterboxd-lab/blob/main/LIVE.md).
