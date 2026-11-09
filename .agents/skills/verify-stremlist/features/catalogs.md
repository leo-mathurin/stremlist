# Catalogs and installation

An Account previews Titles before saving and installs an Addon URL so Stremio can read its Catalogs and metadata.

## Sub-features

- `catalogs.preview` previews new or saved Lists, sort settings, genres, and Unresolved entries without changing saved Catalogs.
- `catalogs.new` configures the New titles Catalog and shows its summary.
- `catalogs.api` serves manifest, Catalog, pagination, and metadata responses for private URLs and Legacy aliases.
- `catalogs.install` copies the Addon URL, handles clipboard denial, and opens Stremio Web installation.
- `catalogs.providers` serves the manifest, Catalogs, meta, and streams of a List of every Provider, and renders them in Stremio Web.
- `catalogs.queue` shows the Letterboxd queue state on the link check, the preview, and the sync line, and the Stremio card "Your Letterboxd list is on its way" when a Catalog without a cache waits more than 10 s.

## How to get to it (user POV)

Paste a new List on Configure or choose `Preview Test catalog` for a saved List. Edit `Sort order` and the New titles setting. After Save, use `Open Stremio Web` or copy the Addon URL. Stremio reads `/{account}/manifest.json` and the manifest's Catalog and metadata URLs.

## Driving it with toolkit and Playwright

Preconditions: toolkit preview fixtures include known Titles and unresolved results. Integration fixtures include database rows and cache objects. Hosted Stremio Web and live IMDb require network access.

- Run `bun run test:toolkit:replay`. `toolkit/catalog-preview.e2e.ts`, `new-titles.e2e.ts`, and `ui.e2e.ts` check preview requests, Title links, unsaved settings, copy fallback, and install-link construction. `toolkit/letterboxd-queue.e2e.ts` checks the queue states and that each retry sends the ticket.
- For `catalogs.queue`, the backend tests `src/__tests__/letterboxd-queue-catalog.test.ts` and the queue cases of `src/providers/__tests__/letterboxd.test.ts` check the Stremio card, the stale Catalog served at once, the incomplete Catalog and its background read. `supabase/tests/letterboxd_queue.sql` checks the queue order in Postgres. `bun run --cwd apps/backend stress:letterboxd-gate --target pg --rate 40` loads it against a disposable Postgres.
- Run `CI=1 bun run --filter @stremlist/e2e test:e2e --project=local tests/catalog-preview.spec.ts tests/new-titles.spec.ts tests/addon-api.spec.ts tests/catalog-features.spec.ts --trace on`. Require Catalog Titles and manifest contents to match saved settings. Preserve assertions that preview has no persistent side effects.
- For `catalogs.providers`, run `CI=1 bun run --filter @stremlist/e2e test:e2e --project=local tests/provider-stremio.spec.ts --trace on`. It uses a fixture backend. Require each Provider's List to have a movie and a series Catalog in the manifest, each Catalog to serve its fixture Title, movie meta from the cache, null series meta, and no streams without Actions. The `@live-regression` test of the same file installs the fixture backend's Addon URL in hosted Stremio Web and requires each Discover page to show the Catalog's Title.
- Run `CI=1 bun run --filter @stremlist/e2e test:e2e --project=live-smoke tests/stremio-install.spec.ts tests/stremio-catalogs.spec.ts tests/stremio-meta.spec.ts --trace on`. Require the installed addon and Catalog Titles in hosted Stremio. Run the same files under `live-regression` for their additional tagged cases.

## Gotchas

- A local HTTP Addon URL has no desktop `stremio://` install link. The app requires HTTPS without an explicit port for that link.
- IMDb is the only Provider with live Stremio Web tests on real data. The other Providers reach Stremio Web only with fixture data.
- Hosted Stremio is an external dependency. A generated link alone does not prove installation.
- Real RPDB poster delivery, playback, and desktop protocol handling require separate verification.
