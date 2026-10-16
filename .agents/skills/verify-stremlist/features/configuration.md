# Configuration and Merged Lists

An Account edits the Lists that become its Stremio Catalogs and keeps those settings after Save and reload.

## Sub-features

- `configuration.edit` adds, removes, renames, reorders, filters, and changes display or sort settings.
- `configuration.merge` merges Source lists, deduplicates Titles, moves sources out, and enforces Account limits.
- `configuration.save` preserves edits during pending or failed saves and detects changes from another window.
- `configuration.reinstall` asks for a reinstall when the installed manifest changes.

## How to get to it (user POV)

Open `/configure` for a new setup or `/configure?account=...` for an existing Account. Add a link or a Quick add chart. Open `Settings for Test catalog`, edit `Catalog title`, use `Drag to reorder`, or choose a merge destination. Save from the Lists column.

## Driving it with toolkit and Playwright

Preconditions: use the toolkit's seeded Lists. Integration specs create their own Accounts and cache objects.

- Run `bun run test:toolkit:replay`. `toolkit/ui.e2e.ts`, `save-refresh.e2e.ts`, `configuration-recovery.e2e.ts`, and `merged-lists.e2e.ts` check visible edits and exact submitted values. Use the first exact `Save` button, as the floating button has the same name.
- Run `CI=1 bun run --filter @stremlist/e2e test:e2e --project=local tests/merged-lists.spec.ts --grep 'merging two Lists on the configure page saves and survives a reload' --trace on`. Require the merge, saved Source lists, and the same structure after reload.
- For the full affected backend behavior, run `CI=1 bun run --filter @stremlist/e2e test:e2e --project=local tests/merged-lists.spec.ts tests/configure-page.spec.ts tests/configuration-transitions.spec.ts tests/catalog-features.spec.ts --trace on`. Require stored values, deduplicated Catalog Titles, and invalid merges leaving saved data intact.

## Gotchas

- A toolkit captured POST proves the payload, not database persistence.
- Limits differ for Lists and Source lists. Keep the assertions for 10 Lists, 20 Source lists per Account, and five sources per Merged List.
- Integration tests share one database and use one worker. Running two suites concurrently invalidates save and cleanup proofs.
