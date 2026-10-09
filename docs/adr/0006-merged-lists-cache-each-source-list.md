# Merged Lists cache each Source list and merge on read

A List can now point to several Source lists (STR-59), so one Catalog can show, for example, an IMDb watchlist and a Trakt watchlist together, each Title once. The List keeps its first Source list in `provider` and `source_ref`, and the others in `merged_sources`, in order. Every List with one Source list stays exactly as before: same row, same cache key (the List ID), same Catalog in its Provider's order. The catalog read handles it as a List with only one Source list, so there is one code path.

Each Source list of a merged List keeps its own cached Catalog, under a key made from the List ID and a hash of the Source list. A catalog request reads each one (cache first, as for any List) and merges them in memory: Titles are deduplicated by IMDb ID ([ADR 0002](0002-titles-are-imdb-ids-only.md)), and a duplicate's "More on Simkl" line is kept, because Simkl's terms ask for it on every item. The merged result is never stored. So each Source list keeps its own freshness, its own fallback to the last cache, and its own Connection rules: when one Source list fails or loses its Connection, the others still show, and nothing private stays served.

"Date added" needs a real date to sort several Source lists together. Adapters now pass the date when each Title joined its Source list (IMDb `createdDate`, Trakt `listed_at` or watch and collect dates, Simkl and MDBList watchlist dates); the cache keeps it and never serves it to Stremio. A merged List can sort by date added only when every Source list gives dates; charts, recommendations and lists kept in the owner's order do not. A List with one Source list keeps its Provider's own order for "Date added", as before.

## Considered Options

- One cache for the merged result, rebuilt from all Source lists at each refresh: simpler, but one failing or disconnected Source list would either hide every Title or keep private Titles in the cache, and all Source lists would refresh at the pace of the fastest one.
- A new `list_sources` table with every Source list, the first one included: cleaner on paper, but it would change every place that reads a List and every cache key, for no gain to Lists with one Source list.
- A merged List made of other Lists (a List that points to Lists): the user would have to keep and hide the inner Lists, and their settings would conflict.
- Merging by concatenation for "Date added": wrong order as soon as two Source lists are mixed, so it is refused instead.

## Consequences

- The merge rules live in `@stremlist/shared/list-merge` and run on the configure page and in the API: at most 5 Source lists per List and 20 per Account, each Source list once per Account, a display mode that keeps each single-type Source list (IMDb charts, Trakt Up Next), and "Date added" only with dates.
- `sourceHasAddedDates` must match what the adapters set; a new Provider or Source list kind updates both.
- A save deletes the caches that it leaves unused (removed Source lists, a List that became merged or changed its Source list).
- A client that omits a List's merged Source lists keeps the saved ones. The API checks the rules against them, and the transaction refuses the save (409) when another save changed them in between, so a stale client cannot undo a merge.
- Each Source list records its own sync status under the List ([ADR 0005](0005-sync-status-recorded-per-list.md)). The cache key is only where its Catalog is kept.
- The Catalog preview ([ADR 0004](0004-previews-read-live-and-cache-nothing.md)) reads every Source list and merges them with the same rules. A Source list that cannot be read is left out and named, as the Catalog leaves it out.
