# New titles are detected by comparing complete synchronizations, entry by entry

Most Providers do not give a reliable date for when a title was added to a Source list (charts and SensCritique give none, others give dates that change on re-adds). So Stremlist records its own Detection: each complete, successful synchronization of a Source list is compared with the previous one, and an entry that was not there before gets the date of that synchronization. The "New titles" catalog shows the Titles of these entries across all Lists of an Account, each Title once with its earliest Detection, newest first. Its descriptions say "Detected by Stremlist on …", because the date is when Stremlist saw the entry, not when the user added it.

A synchronization is complete and successful when the Provider read did not fail and reached the last page (no page or item cap cut it). Any other read still serves the Catalog but is never compared: a missing entry in it could be a page that was not read, and comparing it would turn into false removals now and false Detections later. The first complete synchronization of a Source list is its Baseline: its entries are known, but never new, so adding Stremlist to a big watchlist does not fill the catalog with old titles.

Synchronizations are compared by entry key, the stable identity of an entry in its Source list, not by IMDb ID. Unresolved entries are part of a synchronization like any other entry, so they never block the Baseline or the Detection of other entries (ADR 0002 says some never resolve). An entry that was known while unresolved is not new when it resolves later. A new entry that resolves later keeps the date of the synchronization where it first appeared.

The entry key is the Provider's own ID for the entry (the ID resolver key, such as `trakt-movie:123` or `justwatch:tm92641`), else its IMDb ID (`imdb:tt…`), else, for Providers that give no ID, its title (lower case, without accents and punctuation) and year (`title:amelie:2001`). An entry with none of these cannot be followed and is left out of the comparison.

## Consequences

- History is keyed by Account and Source list, not by List: removing a List and adding it again keeps the Baseline, and changing a List to another Source list never mixes two histories. A private copy of a Legacy alias install starts with its own Baseline.
- History is durable. A removal only marks the entry; an entry that comes back keeps its first Detection and does not count as new again. A Title is never new in a Source list where one of its entries is in the Baseline, so an entry whose key changes (a Provider adds an ID, a title is corrected) does not make its Title new. A title and year key can change when the Provider edits the title; the entry then shows as removed and added, which only matters when it was not resolved before.
- The history of a Source list that only a Connection can read (`me/history`…) belongs to that Connection's Provider user. A synchronization is recorded only while that Connection still exists for the same user, so a read that ends after a disconnect cannot bring the history back, and another user starts a new Baseline. A disconnect or a new Connection cleans up in the same transaction (`delete_connection`, `save_connection`) and keeps only the history of the user that is connected after it (none after a disconnect). Deleting the Account deletes all of it.
- When two reads of the same Source list overlap, the one that started last wins: a synchronization is dated by the start of its read.
- A Title keeps its earliest Detection among the Lists where it is new, also after the first of them drops it, as long as one of them still has it.
- The catalog setting is saved in the same transaction as the Lists (`replace_account_config`).
- A Source list gets no Baseline while every read fails or is cut short. The configure page shows how many Lists wait for that; a merged List waits while one of its Source lists has no Baseline.
- Each Source list of a merged List ([ADR 0006](0006-merged-lists-cache-each-source-list.md)) keeps its own history. A Source list whose read fails or is cut short is not compared, and the others of the List still are. A Title that two Source lists of one List add is one new title, with the earliest Detection. A Source list merged into a List later starts with its own Baseline, so merging never fills the catalog with old titles.
- The "New titles" Catalogs are part of the manifest Catalogs that the configure page compares (`addonCatalogEntries` in `@stremlist/shared/manifest-catalogs`), so turning them on or off asks for a reinstall like any other Catalog change.
- Detections are recorded for every Account, also when the catalog is off, so turning it on shows the history at once. The catalog reads metadata from the cached Catalogs only and never calls a Provider.

## Considered Options

- Use the Provider's addition date (`listed_at`, `added_at`): missing for charts, SensCritique and JustWatch editorial lists, and it describes the Provider, not what Stremlist saw.
- Compare IMDb IDs and count a read with an Unresolved entry as incomplete: a Source list with one entry that never resolves would never get a Baseline, and a known entry that resolves late would look new.
- Compare every read, complete or not: simple, but each failed or partial read would look like removals followed by a wave of false Detections.
- Mark everything in the first read as new: the first catalog would be the whole watchlist.
