# Configuration and Merged Lists

An Account edits the Lists that become its Stremio Catalogs and keeps those settings after Save and reload.

## Sub-features

- `configuration.edit` adds, removes, renames, reorders, filters, and changes display or sort settings.
- `configuration.merge` merges Source lists, deduplicates Titles, moves sources out, and enforces Account limits.
- `configuration.save` preserves edits during pending or failed saves and detects changes from another window.
- `configuration.reinstall` asks for a reinstall when the installed manifest changes.
- `configuration.stremio-update` offers to link a Stremio account instead, then updates the installed Stremlist on each catalog save. It covers the code page, expiry, a code that Stremio does not give, a browser that blocks the Stremio tab, outages, a save during an update (one update at a time), a signed-out session, a removed install, another account, disconnecting, the repair on page load, and a Legacy alias install, which only reinstalls by hand.

## How to get to it (user POV)

Open `/configure` for a new setup or `/configure?account=...` for an existing Account. Add a link or a Quick add chart. Open `Settings for Test catalog`, edit `Catalog title`, use `Move up` or `Move down` under `Catalog order`, or choose a merge destination. `Drag to reorder` is also available on the row handle. Save from the Lists column.

## Driving it with toolkit and e2e integration

Preconditions: use the toolkit's seeded Lists. Integration specs create their own Accounts and cache objects.

- Run `bun run test:toolkit:replay`. `toolkit/ui.e2e.ts`, `save-refresh.e2e.ts`, `configuration-recovery.e2e.ts`, and `merged-lists.e2e.ts` check visible edits and exact submitted values. Use the first exact `Save` button, as the floating button has the same name.
- `toolkit/configure-ux.e2e.ts` checks order buttons at phone width, movement by tap and keyboard, disabled buttons at each end and for a single List, and the saved positions. The settings stay open when their List moves.
- `test/touch-reorder.e2e.ts` uses native Chromium touch input at phone width to check immediate handle movement in both directions, a tap without reordering, scrolling outside the handle, and the submitted order. API responses use the existing toolkit fixtures; no database persistence is claimed.
- `toolkit/stremio-sync.e2e.ts` answers the backend's `/:accountId/stremio/*` routes over a Stremio account in memory and asserts the written addon collection: only the Stremlist entry changes, in place. The backend keeps the key (ADR 0002): `src/test/stremio-routes.test.ts` covers its encryption, the link token bound to the Account, the update lease, the forgotten signed-out key and the real collection edits, and `src/services/test/stremio.test.ts` covers the Stremio client.
- In `src/services/test/stremio.test.ts`, a linked Supporter admin updates existing copies of the same Addon URL across profiles. Check a secondary-only install, different and absent installs, addon order, and a profile write Stremio does not keep.
- Run `CI=1 bun run --filter @stremlist/e2e test:e2e --tag local test/merged-lists.e2e.ts --grep 'merging two Lists on the configure page saves and survives a reload' --trace on`. Require the merge, saved Source lists, and the same structure after reload.
- For the full affected backend behavior, run `CI=1 bun run --filter @stremlist/e2e test:e2e --tag local test/merged-lists.e2e.ts test/configure-page.e2e.ts test/configuration-transitions.e2e.ts test/catalog-features.e2e.ts --trace on`. Require stored values, deduplicated Catalog Titles, and invalid merges leaving saved data intact.

## Gotchas

- A toolkit captured POST proves the payload, not database persistence.
- A new List goes first, from a link or Quick add. After Save it is the first Catalog in Stremio, so expect it at position 0 and the older Lists after it.
- Limits differ for Lists and Source lists. Keep the assertions for 10 Lists, 20 Source lists per Account, and five sources per Merged List.
- Integration tests share one database and use one worker. Running two suites concurrently invalidates save and cleanup proofs.
- Never point `configuration.stremio-update` at a real Stremio account from a test. The linked key is the stremio.com session that confirmed the code: a Stremio logout with it signs that browser out of stremio.com. A real check needs the owner's consent, a backup of the addon collection, and a restore.
- The manual steps sit behind `I'll reinstall myself`. Open it before looking for `Reinstall` or `I did it`.
