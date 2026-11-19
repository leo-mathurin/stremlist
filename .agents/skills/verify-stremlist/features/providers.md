# Providers and Actions

An Account connects a Provider to read private Source lists and chooses where Stremio Actions write Titles.

## Sub-features

- `providers.public` adds supported public links and Quick add charts.
- `providers.connection` connects, disconnects, renews, and recovers a pending link after OAuth. Only the browser that started a connect can complete it, and a new setup gets its Account only when the connection succeeds.
- `providers.upgrade` upgrades a Legacy alias to a private Addon URL before enabling Actions. The copy uses the setup on the page, and the legacy install keeps serving and stays editable.
- `providers.actions` saves Provider order and reports success, failure, and retry for title Actions.

- `providers.activity` chooses watched marks and library-to-watchlist additions separately in Options. The first enable needs consent. Stop sharing cancels pending delivery after confirmation.

## How to get to it (user POV)

Paste a Provider link on Home or Configure. Use Quick add or the Providers panel. A List that needs authorization offers a Connect or Connect again control. Actions settings appear on Configure. Stremio exposes Actions through addon metadata.

## Driving it with toolkit and Playwright

Preconditions: toolkit fixtures advertise available Providers and Connections. Integration Provider specs start isolated fixture backends with dummy OAuth applications and intercepted Provider transports.

- Run `bun run test:toolkit:replay`. `toolkit/providers.e2e.ts`, `connect-security.e2e.ts` and `sync-status.e2e.ts` check the pasted-link, Quick add, Providers-panel, and List-recovery entry points. Require the selected Provider, resumed List, confirmation before disconnect, and saved Actions order.
- Run `CI=1 bun run --filter @stremlist/e2e test:e2e --project=local test/provider-links.test.ts test/provider-connections.test.ts test/provider-actions.test.ts test/provider-contract.test.ts --trace on`. Require persisted Connection state, permitted outbound requests, Action receipts, and failure behavior asserted by those specs.

For `providers.activity`, run the local `test/watch-tracking.test.ts` suite with trace enabled. It checks real handlers, the database and queue, with controlled Stremio and provider HTTP responses. Require consent cancel and allow, independent choices after reload, native watched confirmation, a recovered cycle, duplicate additions, provider failure and retry, and stop sharing. Run `supabase/tests/watch_tracking.sql` and `supabase/tests/stremio_activity.sql` in the disposable database. Library additions need client events; the six-hour sweep recovers watched marks, not missing additions.

## Gotchas

- Fixtures exercise real adapters but do not log in to real Trakt, Simkl, or MDBList consent screens. Do not claim live OAuth from this pass.
- Provider Actions can mutate real accounts outside fixtures. Keep the controlled fixture transport for routine verification.
- Letterboxd reads public watchlists and lists without a Connection. `provider-links.test.ts` verifies stored configuration, movie/series Catalogs, and a shared upstream read across Accounts. Private lists and Actions remain unsupported.
