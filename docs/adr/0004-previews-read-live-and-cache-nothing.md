# Catalog previews read the Source list live and write no Catalog cache

The configure page shows a Catalog preview for each List: the first Titles of each Catalog that the List adds to Stremio, and the List's Unresolved entries. A List can be previewed before it is saved, so it often has no List ID and no cached Catalog. The R2 cache also keeps only the Titles, not the Unresolved entries.

So `POST /lists/preview` reads the Source list through the same pipeline as a catalog request (`buildCatalog` in `services/lists.ts`: adapter, ID resolver, enrichment), then applies the same sort, display mode, filters and presets as the catalog route. It writes no Catalog cache: saving the List stays the only step that changes what Stremio shows. The ID resolver still stores what it finds in `title_id_map`, so the first catalog read after the save is faster.

Changing the sort or the filters asks for a new preview each time, so each backend instance keeps a read for 5 minutes (30 seconds when some entries were not checked yet). A read through a Connection can hold private Titles: it is kept per Account and per authorization of the Connection (a fingerprint of its access token). It never serves another Account, a request without the Connection, or a new Connection of the same Account. The configure page also asks again when a Connection of the List's Provider changes. A Legacy alias never reads through a Connection (ADR 0001).

## Consequences

- A preview costs one Provider read, like a catalog request. The panel reads only while it is open, and only Lists added during the visit open it automatically.
- Posters in the preview are the plain posters, without RPDB ratings, and Shuffle uses a seed of its own, so the order can differ from Stremio.
- The first preview of a big list with many entries without an IMDb ID can take several seconds, because the resolver runs within the normal catalog budget.
