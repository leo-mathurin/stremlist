# New titles are detected by comparing complete synchronizations

Most Providers do not give a reliable date for when a title was added to a Source list (charts and SensCritique give none, others give dates that change on re-adds). So Stremlist records its own Detection: each complete, successful synchronization of a Source list is compared with the previous one, and a Title that was not there before gets the date of that synchronization. The "New titles" catalog shows these Titles across all Lists of an Account, each Title once with its earliest Detection, newest first. Its descriptions say "Detected by Stremlist on …", because the date is when Stremlist saw the Title, not when the user added it.

A synchronization is complete and successful only when the Provider read did not fail, reached the last page (no page or item cap cut it), and left no Unresolved entry. Any other read still serves the Catalog but is never compared: a missing Title in it could be a page that was not read or an entry that is not resolved yet, and comparing it would turn into false removals now and false Detections later. The first complete synchronization of a Source list is its Baseline: its Titles are known, but never new, so adding Stremlist to a big watchlist does not fill the catalog with old titles.

## Consequences

- History is keyed by Account and Source list, not by List: removing a List and adding it again keeps the Baseline, and changing a List to another Source list never mixes two histories. A private copy of a Legacy alias install starts with its own Baseline.
- History is durable. A removal only marks the row; a Title that comes back keeps its first Detection and does not count as new again. Only a disconnect deletes the history of Source lists that need that Connection, and deleting the Account deletes all of it.
- A Source list that always has an Unresolved entry never gets a Baseline, so nothing is detected in it until that entry resolves. The configure page shows how many Lists wait for a complete refresh.
- Detections are recorded for every Account, also when the catalog is off, so turning it on shows the history at once. The catalog reads metadata from the cached Catalogs only and never calls a Provider.

## Considered Options

- Use the Provider's addition date (`listed_at`, `added_at`): missing for charts, SensCritique and JustWatch editorial lists, and it describes the Provider, not what Stremlist saw.
- Compare every read, complete or not: simple, but each failed or partial read would look like removals followed by a wave of false Detections.
- Mark everything in the first read as new: the first catalog would be the whole watchlist.
