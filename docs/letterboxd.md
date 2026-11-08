# Public and share-link Letterboxd lists

Stremlist reads full public watchlist and list URLs, for example `https://letterboxd.com/member/watchlist/` and `https://letterboxd.com/member/list/list-name/`. A Letterboxd Connection is not required, and no credentials are stored (ADR 0001). Account Actions and lists visible only to the owner or to friends are not supported.

A member can share a non-public list by setting it to "Anyone with share link" on Letterboxd. Stremlist reads that list through its share URL (`https://letterboxd.com/member/list/list-name/share/<token>/`) or its `boxd.it` short link. A public `boxd.it` short link resolves to its canonical list too.

Stremlist also reads a member's other public pages as Source lists: watched films (`/member/films/`, including a rating filter such as `/member/films/rated/4.0-5.0/` as its own Source list), the diary (`/member/diary/`, a history Source list that keeps each Title once with its most recent watch date), and liked films (`/member/likes/films/`). The "Popular this week" and "Popular this month" charts are built-in Source lists that need no link. A chart ranks every film on Letterboxd, so its Source list is the first page (the top 72). The chart page loads its grid with JavaScript; Stremlist reads the grid fragment (`/csi/films/films-browser-list/…`) directly. A rating filter is stored in Letterboxd's own form of the range (`4.0-5.0` becomes `4-5`), which its pagination links use. All of these are public pages; a private profile is not readable.

This adapter belongs to the multi-provider branch. It does not deploy that branch or migrate the current production database.

## Share links

The share token is a secret. Stremlist encrypts it with the Connection key (`CONNECTION_ENCRYPTION_KEY`, AES-256-GCM) before it becomes part of the stored Source list reference (`share/v1:…`). The configure page shows only "Shared list", never the token, the slug, or a clickable URL, and logs never print the reference. The page cache keys on a SHA-256 of the decrypted path, so two Accounts with the same share link share one cached page.

A `boxd.it` short link is followed once on the backend (in `validateSource`). A link that resolves to a film or a member, not a list or watchlist, is refused. When a share link is revoked (the list leaves "Anyone with share link" or is deleted), Letterboxd answers HTTP 404; Stremlist then clears the Catalog instead of serving the Titles it cached before, the same as a deleted or hidden public list.

## Reads and title IDs

The adapter reads anonymous HTML, with the Stremlist User-Agent and manual redirects. It requires explicit document closing tags and a positively closed empty grid, or the closed "No films yet" block of an empty watchlist or list, before accepting an empty page. A chart fragment must close its grid and its pagination block. It validates every page and its pagination before recording HTTP success or caching it, follows only the next numbered page of the same collection, deduplicates stable `film:…` IDs and stops at 40 pages. A capped read is incomplete and does not advance detection history. Watchlists use oldest-added order; ranked lists keep their page order.

IMDb resolution first uses exact [Wikidata Letterboxd IDs](https://www.wikidata.org/wiki/Property:P6127), by stable ID and then slug. Missing mappings use the film page's exact IMDb link. No title similarity match is used. Wikidata reads stay grouped in batches of 50; paced film pages are read one at a time. The resolver checks its soft budget between strategy batches. Failed and unattempted lookups stay deferred without a negative cache row. The existing shared `title_id_map` stores the result, so films in several lists do not need another lookup. Entries without an IMDb ID remain unresolved and are retried by the common resolver.

## Shared cache and request coordination

Parsed public pages live in R2 under `providers/letterboxd/pages-v1/`. They are shared between Accounts and remain fresh for six hours. Conditional writes give one worker the page lease. A manual Refresh now waits for an older in-process refresh to settle, then revalidates the pages. It does not join an ordinary cached read or wait for the six-hour expiry. Catalog metadata, stale fallback, sync status and detection history use the existing List pipeline.

The R2 object `providers/letterboxd/http-v1.json` coordinates outbound requests across instances. At most one request is in flight. The next worker waits until three seconds after completion, below the roughly 23.6 requests/minute observed in the lab. A cold request waits at most 15 seconds for capacity and a page waiter at most 10 seconds. Storage failure denies new sends. This is a bounded rollout, not evidence for 50k distinct users at an arbitrary refresh frequency.

A 403, 429, challenge response header or challenge document halts new outbound reads. Network errors, unusable collection HTML and timeouts while reading an HTTP 200 body pause requests for at least 15 minutes and respect Retry-After. Three consecutive failed reads or an expired HTTP reservation halt requests. A failed page never replaces a valid cached page with an empty result.

## Operation

`DISABLED_PROVIDERS=letterboxd` is the existing application kill switch. A halt makes Letterboxd unavailable in the same way: the configure page shows it as temporarily unavailable, new Letterboxd links are refused, and Lists keep their last Catalog with a sync note. The instance that flips the shared state to halted also reports to `BETTERSTACK_HEARTBEAT_URL_LETTERBOXD` (`/fail`) at once; `/monitor` probes the Popular this week chart on its schedule. Apply environment changes through a reviewed deployment. Cached Catalogs remain available through the common fallback.

Inspect the HTTP state object after a halt. `activeId` with an expired lease means an unknown result; `failures >= 3` means repeated failures; a halted state with neither means an explicit refusal or challenge. Check the cause before resetting the state. Reset only this HTTP state object, with no requests in flight. Keep page and title-ID caches. The state must remain outside any R2 lifecycle rule that deletes inactive objects while the provider is halted.

The previous lab recorded 32,197 valid pages over 30h23, with no detected 403/429/challenge. A body timeout stopped that campaign early. It did not complete 72 hours or prove a quota for 50k users. Evidence is in the private [lab report](https://github.com/leo-mathurin/stremlist-letterboxd-lab/blob/main/LIVE.md).
