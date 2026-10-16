# Providers and Actions

An Account connects a Provider to read private Source lists and chooses where Stremio Actions write Titles.

## Sub-features

- `providers.public` adds supported public links and Quick add charts.
- `providers.connection` connects, disconnects, renews, and recovers a pending link after OAuth.
- `providers.upgrade` upgrades a Legacy alias to a private Addon URL before enabling Actions.
- `providers.actions` saves Provider order and reports success, failure, and retry for title Actions.

## How to get to it (user POV)

Paste a Provider link on Home or Configure. Use Quick add or the Providers panel. A List that needs authorization offers a Connect or Connect again control. Actions settings appear on Configure. Stremio exposes Actions through addon metadata.

## Driving it with toolkit and Playwright

Preconditions: toolkit fixtures advertise available Providers and Connections. Integration Provider specs start isolated fixture backends with dummy OAuth applications and intercepted Provider transports.

- Run `bun run test:toolkit:replay`. `toolkit/providers.e2e.ts` and `sync-status.e2e.ts` check the pasted-link, Quick add, Providers-panel, and List-recovery entry points. Require the selected Provider, resumed List, confirmation before disconnect, and saved Actions order.
- Run `CI=1 bun run --filter @stremlist/e2e test:e2e --project=local tests/provider-links.spec.ts tests/provider-connections.spec.ts tests/provider-actions.spec.ts tests/provider-contract.spec.ts --trace on`. Require persisted Connection state, permitted outbound requests, Action receipts, and failure behavior asserted by those specs.

## Gotchas

- Fixtures exercise real adapters but do not log in to real Trakt, Simkl, or MDBList consent screens. Do not claim live OAuth from this pass.
- Provider Actions can mutate real accounts outside fixtures. Keep the controlled fixture transport for routine verification.
- Letterboxd links explain the MDBList import path. Direct Letterboxd support is not implemented.
