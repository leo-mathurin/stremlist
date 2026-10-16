# Catalogs and installation

An Account previews Titles before saving and installs an Addon URL so Stremio can read its Catalogs and metadata.

## Sub-features

- `catalogs.preview` previews new or saved Lists, sort settings, genres, and Unresolved entries without changing saved Catalogs.
- `catalogs.new` configures the New titles Catalog and shows its summary.
- `catalogs.api` serves manifest, Catalog, pagination, and metadata responses for private URLs and Legacy aliases.
- `catalogs.install` copies the Addon URL, handles clipboard denial, and opens Stremio Web installation.

## How to get to it (user POV)

Paste a new List on Configure or choose `Preview Test catalog` for a saved List. Edit `Sort order` and the New titles setting. After Save, use `Open Stremio Web` or copy the Addon URL. Stremio reads `/{account}/manifest.json` and the manifest's Catalog and metadata URLs.

## Driving it with toolkit and Playwright

Preconditions: toolkit preview fixtures include known Titles and unresolved results. Integration fixtures include database rows and cache objects. Hosted Stremio Web and live IMDb require network access.

- Run `bun run test:toolkit:replay`. `toolkit/catalog-preview.e2e.ts`, `new-titles.e2e.ts`, and `ui.e2e.ts` check preview requests, Title links, unsaved settings, copy fallback, and install-link construction.
- Run `CI=1 bun run --filter @stremlist/e2e test:e2e --project=local tests/catalog-preview.spec.ts tests/new-titles.spec.ts tests/addon-api.spec.ts tests/catalog-features.spec.ts --trace on`. Require Catalog Titles and manifest contents to match saved settings. Preserve assertions that preview has no persistent side effects.
- Run `CI=1 bun run --filter @stremlist/e2e test:e2e --project=live-smoke tests/stremio-install.spec.ts tests/stremio-catalogs.spec.ts tests/stremio-meta.spec.ts --trace on`. Require the installed addon and Catalog Titles in hosted Stremio. Run the same files under `live-regression` for their additional tagged cases.

## Gotchas

- A local HTTP Addon URL has no desktop `stremio://` install link. The app requires HTTPS without an explicit port for that link.
- Hosted Stremio is an external dependency. A generated link alone does not prove installation.
- Real RPDB poster delivery, playback, and desktop protocol handling require separate verification.
