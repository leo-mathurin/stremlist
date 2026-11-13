# Refresh and sync status

An Account refreshes its Lists and sees when Titles last loaded or why a Provider read failed.

## Sub-features

- `refresh.manual` runs Refresh now, reports partial failures, and enforces cooldown.
- `refresh.status` polls saved Lists and each source of a Merged List until status updates.
- `refresh.recovery` renews a refused Connection and clears the error after a successful refresh.
- `refresh.cache` retains the last successful Catalog during transient failures and handles lost Connections separately.

## How to get to it (user POV)

Open `/configure?account=...` or a Legacy alias link. Read the status beside each List. Choose `Refresh now`, wait through `Refresh in ...s`, or use the affected List's Connect again control. Opening Stremio also reads and refreshes stale Catalogs.

## Driving it with toolkit and Playwright

Preconditions: toolkit fixtures provide changing sync-status responses and a controlled clock where the existing spec needs one. Integration specs seed a previous successful refresh and a failing Provider transport.

- Run `bun run test:toolkit:replay`. `toolkit/sync-status.e2e.ts`, `refresh-recovery.e2e.ts`, and `save-refresh.e2e.ts` verify polling, failure messages, retry, cooldown expiry, and distinct Connect again controls. Require the actual request and updated visible status.
- Run `CI=1 bun run --filter @stremlist/e2e test:e2e --project=local tests/sync-status.spec.ts tests/provider-sync-status.spec.ts tests/merged-lists.spec.ts --trace on`. Require the failure to survive reload, the last success to remain stored, and unaffected Source lists to keep their Catalog Titles.
- Include `tests/sync-status.spec.ts` and `tests/provider-sync-status.spec.ts` in the controlled integration run when refresh or Provider authorization changes. `tests/sync-status.spec.ts` checks Legacy alias access too.

## Gotchas

- Integration uses a two-second refresh cooldown. Toolkit fixtures also test longer server cooldowns. Do not replace either with an arbitrary sleep.
- An unsaved List has no persisted sync status. A new saved List waits for its first refresh.
- Cache and prewarm unit tests cover more failure cases than the browser specs. Consult the coverage reference for targeted checks.
