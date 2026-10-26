# Public Markdown and AI discovery

The frontend serves Markdown for its three indexable HTML pages. It renders the
same shared content that the React pages use. It does not scrape HTML or read
Account data.

| HTML page    | Markdown        | Direct endpoint     | Content                                             |
| ------------ | --------------- | ------------------- | --------------------------------------------------- |
| `/`          | `/index.md`     | `/api/md/`          | Home text, Provider availability, public user count |
| `/changelog` | `/changelog.md` | `/api/md/changelog` | All published release entries                       |
| `/terms`     | `/terms.md`     | `/api/md/terms`     | Terms and Privacy Policy                            |

Each page also accepts `Accept: text/markdown`. Markdown must have a higher
quality value than HTML. Missing Accept headers, wildcard-only headers and ties
keep HTML. Registered HTML responses vary on Accept. Markdown responses use
`noindex, follow` and identify the canonical HTML URL.

Configuration, Account URLs, Actions, OAuth callbacks and operational endpoints
have no Markdown renderer. An unknown or excluded Markdown address returns a
Markdown 404. The registry never loads private lists, Connections or tokens.

## Sources and request handling

- `apps/frontend/src/content/` holds site facts and the public content shared by
  HTML and Markdown. The existing public stats endpoint supplies the homepage
  count through one shared loader; unavailable counts are omitted in both formats.
- `apps/frontend/src/lib/md/registry.ts` lists the public page renderers. Their
  metadata drives HTML head tags, the catalog, discovery links and the sitemap.
- `apps/frontend/middleware.ts` sends Markdown and discovery requests to one
  Vercel function, `apps/frontend/api/ai.ts`. Other API paths and static assets
  bypass Markdown negotiation.
- `apps/frontend/scripts/ai-pages.ts` uses the same handler in Vite development
  and preview. It emits page-specific HTML shells during builds so head tags are
  available without JavaScript. React keeps those tags current during navigation.

`/llms.txt`, `/llms-full.txt`, `/ai.txt`, `/robots.txt`, `/sitemap.xml` and
`/api/md/_catalog` are generated from the shared configuration and registry.
The full-content response uses the same renderers, with a daily public snapshot
and shared cache headers. Markdown pages cache for one hour. Errors are not cached.

A single `User-agent: *` group allows all crawlers to fetch public content. It
excludes private paths, with an exception for the public `/api/md/` endpoints. The AI policy permits training on public content and excludes private
Account data. Robots rules describe crawler preferences; Account access still
depends on the existing private Addon URL.

There is no public MCP server or OpenAPI document, so neither is advertised.

## Add a public page

Implement the HTML page using shared content, then add one entry to the
`pages` registry with its path, metadata, content date, section and renderer.
Use `useSEO({ path: "/new-page" })` in its React component. The Markdown suffix,
negotiation, direct endpoint, catalog, discovery files and HTML head generation
then use that entry automatically. The middleware selects its generated HTML
shell from the same registry.

A route coverage check fails if a React route has no renderer or explicit reason
in `SKIPPED_HTML_ROUTES`. Existing Markdown assets must be listed in
`PASSTHROUGH_MARKDOWN_ROUTES`; they must not be interpreted as HTML alternates.

## Check the result

Run `bun run --cwd apps/frontend test` for route coverage, HTTP negotiation,
response headers, content parity, privacy exclusions and discovery checks. The
HTTP tests use a real Vite server and a local public-stats fixture.

After starting the frontend, these checks use its printed origin:

```sh
curl -sI http://localhost:5173/terms.md
curl -s -H 'Accept: text/markdown' http://localhost:5173/terms
curl -sI -H 'Accept: */*' http://localhost:5173/
curl -si http://localhost:5173/does-not-exist.md
curl -s http://localhost:5173/llms.txt
curl -s http://localhost:5173/llms-full.txt | wc -c
curl -s http://localhost:5173/ai.txt
curl -s http://localhost:5173/api/md/_catalog
curl -s http://localhost:5173/robots.txt
```

Before delivery, also run the repository's `verify-stremlist` skill. Local Vite
checks do not prove Vercel middleware routing; check the same HTTP cases on a
deployment before claiming that production behavior is verified.
