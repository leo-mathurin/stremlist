# The sync status of each List is recorded at every refresh

With several Providers (STR-16), one Account mixes Source lists that fail for different reasons: a private IMDb watchlist, a deleted Trakt list, a Provider that does not answer, a Connection that the Provider no longer accepts. The configure page only showed one account-wide "Refreshed" time, so a List that served old cached Titles looked healthy, and a refused Connection still showed as "Connected".

Each refresh of a List now records its outcome in Postgres (`list_sync_status`, one row per List and Source list), through one RPC that keeps the start of a failure run. The write happens inside the read that concurrent requests share, so a busy Catalog writes once per refresh. A failed write is logged and never fails the Catalog. A Connection that the Provider refuses gets `needs_renewal_since` ([providers.md](../providers.md) says when it is set and cleared). After a new authorization, that Provider's Lists are read again at once, without joining a read that started with the older tokens.

The configure page gets the statuses with the config, after "Refresh now", and from `GET /:accountKey/sync-status`, which it polls only while a saved List waits for its first refresh. One shared rule (`listSyncState`) turns a status and the Connection into what the row shows. The problem copy is the same as the catalog card in Stremio (`sourceProblemCopy`).

## Considered Options

- Store the status in the R2 cache manifest: no database write, but a failed read must not touch the cache generation, and the configure page would read one R2 object per List.
- Derive "needs renewal" from the List statuses only: no new column, but a Connection used only for Actions, or a public List read through it, would never show it.
- Log failures only: the user cannot see them.

## Consequences

- Lists cached before this change have no row. Their status comes from the cache manifest until their next refresh, and their first failed refresh keeps the cached time and count as the last success, because Stremio still gets those Titles. A List that changed its Source list shows "Not refreshed yet" until it is read again.
- A List with several Source lists (STR-59) gets one row per Source list. The API sends them in `syncStatus`, one entry per Source list in the List's order (null for one never read), and the configure page combines them (`mergedListSyncState`): a problem names its Source list and says whether the others still show. A disconnect forgets only the rows of the Source lists read through that Connection, in the same transaction as the Connection (`delete_connection`).
- A token refresh that fails for a network reason also marks the Connection. The next read that works clears the mark.
