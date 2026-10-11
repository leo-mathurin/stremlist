# The detection history lives in R2, one object per Source list

The detection history of ADR 0007 started as two Postgres tables: one row per Source list (`source_list_syncs`) and one row per entry of each Source list (`source_list_entries`). A load test with 6,000 Accounts, the size of production, wrote 3.05 million entry rows and 1 GB after one synchronization of each Source list. The production database is on the Supabase Free plan (500 MB). The table would also grow without end, because removed entries stay, and two of its queries got slower as the history grew. In 2026 the catalog caches already moved from Postgres to R2 for the same reason.

So each Account and Source list now has one JSON object in the cache bucket (`services/title-history.ts`): its Baseline date, its last complete synchronization, the Connection it belongs to (for a Source list that only a Connection can read), and one small tuple per entry key (IMDb ID, detection date, removal date). A complete synchronization reads the object, compares in memory, and writes it back with a conditional write (the ETag it read). When another instance wrote in between, the write fails and the comparison runs again on the newer version. The "New titles" catalog reads the objects of the Account's Source lists (20 at most) and applies the rules of ADR 0007 in memory (`listNewTitles`).

No SQL table, function or migration depends on the size of the history any more.

## Considered Options

- Keep the tables and fix the slow queries: the size alone does not fit the Free plan, and it grows with every user and every chart.
- Keep the tables and prune them: smaller, but still about 0.5 GB at today's size, and it would be the largest part of the database.
- One R2 object per entry: no read-modify-write, but thousands of R2 writes per synchronization (R2 bills each write).
- Postgres row per Source list with the entries in a compressed column: fewer rows, but the same size problem, in a database that has no room for it.

## Consequences

- The history of a Source list that only a Connection can read is under that Connection's R2 prefix (`connections/<account>/<provider>/history/`), so a disconnect deletes it with the Action membership and the Provider state. It also names its Connection (Provider user and `connections.created_at`). The backend uses it only while that same Connection exists, so a write that lands after a disconnect, or the history of another Provider user, is never used. A renewal of the same Connection keeps `created_at`, so it keeps the history.
- The other histories are under `history/<account>/`. Removing a List keeps its history, as before.
- A synchronization that changes nothing writes nothing, except once a day. So the bucket's 30-day lifecycle rule deletes only the histories of Source lists that nobody read for 30 days. Their next complete synchronization is a new Baseline, so it never makes old titles look new.
- A removed entry is forgotten 180 days after its removal, so a chart's history stops growing.
- The conditional write replaces the database row lock. A synchronization that started before the recorded one is still refused. When a synchronization changes nothing, it writes nothing and keeps the older date. A slower read that started before it, but after that older date, can then still be compared. This is rare (two instances must read the same Source list at the same time) and it can only add a Detection that the next synchronization keeps or marks as removed.
- The account cleanup script deletes `history/<account>/` and `connections/<account>/` with the List caches.
- The configure page counts a List as waiting while one of its Source lists has no history that applies, as before.
