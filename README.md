# Stremlist

![Stremlist OG Image](https://stremlist.com/og-image.png)

Stremlist is a Stremio addon that shows your watchlists and lists from IMDb, Trakt, Simkl, MDBList, JustWatch and SensCritique as catalogs in Stremio, so you can browse your saved movies and TV shows directly inside Stremio. With a connected Trakt, Simkl or MDBList account, it can also add titles to your watchlist, mark them as watched and rate them from Stremio.

The vocabulary used in the code and in these docs (Account, Provider, Source list, List, Catalog, Title, Connection, Action) is defined in [`CONTEXT.md`](CONTEXT.md). Architecture decisions are in [`docs/adr/`](docs/adr/), and how each Provider is read is in [`docs/providers.md`](docs/providers.md).

## Features

- Paste a link to a list from any supported Provider; Stremlist detects the Provider
- IMDb watchlists, lists and charts; Trakt, Simkl and MDBList lists (public or through a connected account); JustWatch shared lists; SensCritique wishlists and lists
- Up to 10 Lists per addon install, each shown as its own catalogs
- Actions in Stremio (optional): add to watchlist, mark as watched and rate on your connected Trakt, Simkl or MDBList accounts
- Supports sorting by title, year, complete release date, rating, runtime, and random order
- Filter by genre or decade, or choose a sort directly from Stremio's Discover genre dropdown (one option at a time)
- Combine genre, decade, maximum runtime and minimum IMDb rating in each catalog configuration
- Search your configured lists from Stremio search
- Optional extra home catalogs: 90 min or less, Top rated, and Shuffle
- Optional Rating Poster Database (RPDB) poster support via API key
- Simple install flow through a hosted configuration UI
- Cache-first watchlist serving with periodic auto-refresh and a manual "Refresh now" control
- Lightweight backend with Supabase for account configuration and Cloudflare R2 for list caching
- Monorepo architecture with Turborepo (`apps` + `packages`)

Reinstall an existing addon to load the new dropdown options. Selecting a genre
or decade preserves the configured sort; selecting a sort temporarily overrides
it. Saved filters always apply together, including to search and extra catalogs.
The dropdown adds one further filter or overrides the sort; None clears only
that temporary selection. Extra catalogs reuse the original list and cache.

Release Year sorts by the IMDb year; Release Date sorts by the complete date
returned by IMDb (which may differ from the original release year). Incomplete
dates sort last, without inventing a day or month. Refresh an older cache to
populate release dates. Date-added sorting uses the Provider's list order. Shuffle stays
stable within a cache generation so scrolling does not repeat items. Popularity
is not offered: the tested IMDb meterRanking field reported an entitlement denial.

### Deploying the multi-provider version

Apply `supabase/migrations/20261006120000_accounts_providers_connections.sql`
in the same release as the backend: it renames `users` to `accounts` and
`user_watchlists` to `lists`, which the previous backend cannot read. List IDs
do not change, so installed addons and their Catalog IDs keep working, and the
R2 cache stays valid. Set the new environment variables below before the deploy.

## Monorepo Structure

This repository follows the Turborepo recommended structure:

```text
.
├── apps
│   ├── backend      # Hono API + Stremio addon endpoints
│   └── frontend     # Vite/React configuration UI
├── packages
│   └── shared       # Shared types/constants used by apps
├── turbo.json
└── pnpm-workspace.yaml
```

## Deployment Architecture

- Frontend and backend are deployed on [Vercel](https://vercel.com)
- Backend serves Stremio addon endpoints and configuration flow
- Supabase stores Accounts, Lists, encrypted Connections (OAuth tokens) and the Title ID cache
- Cloudflare R2 stores gzip-compressed List cache objects and Action membership snapshots

## Getting Started

### Prerequisites

- Node.js 24+ for development with Portless (`.node-version`)
- pnpm 10+

### Install

```bash
pnpm install
```

### Run in Development

Decrypt the backend environment first (see below), then run:

```bash
pnpm dev             # both apps through Portless
pnpm dev:tailnet     # both apps; share the frontend over Tailscale HTTPS
pnpm dev:backend     # backend only
pnpm dev:frontend    # frontend only (requires a running backend)
pnpm exec portless list
```

Portless 0.15.6 is pinned as a dev dependency. In the main checkout, the
local names are `https://stremlist.localhost` and
`https://api.stremlist.localhost`. Linked worktrees receive a branch prefix;
use the printed URLs or `pnpm exec portless list` instead of hardcoding them.
A previously configured proxy port (such as 1355) appears in these URLs too.

For access from another tailnet device, open the **Tailscale URL** printed for
the frontend. The browser uses `/api` on that same origin, and Vite forwards
requests to the matching worktree's backend. Stremio install links and configure
redirects use that origin too. No machine-specific browser API URL is needed.

See [the Portless development guide](docs/portless-development.md) for first-run
setup, HTTPS, environment overrides, plain-port fallback, and cleanup.

### Decrypt environment files

The repo stores encrypted env files as `apps/backend/.env.enc` and `apps/frontend/.env.enc`. Decrypt them with [SOPS](https://getsops.io) and an age private key that matches a recipient in `.sops.yaml`.

1. Install `sops`.
2. Give SOPS your age private key. Use one of these options:

```bash
export SOPS_AGE_KEY_FILE="$HOME/.config/sops/age/keys.txt"
# or:
export SOPS_AGE_KEY="AGE-SECRET-..."
```

On macOS, SOPS also reads `~/Library/Application Support/sops/age/keys.txt` if you do not set those variables.

3. Decrypt into local `.env` files (gitignored):

```bash
sops decrypt apps/backend/.env.enc > apps/backend/.env
sops decrypt apps/frontend/.env.enc > apps/frontend/.env
```

Do not commit the decrypted `.env` files.

## Build and Quality Commands

From repository root:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm format
pnpm format:check
```

## Using the Addon

### Public/Hosted Instance

1. Open the configure page and paste a link to a list (or connect a Trakt, Simkl or MDBList account)
2. Save: Stremlist creates your private Addon URL (`[BACKEND_URL]/sl_…/manifest.json`)
3. Install it in Stremio. Keep the URL: it is the only key to your configuration
4. (Optional) Add your RPDB API key on the configure page to use rating posters

Installs made before private URLs existed (`[BACKEND_URL]/ur…/manifest.json`) keep working as Legacy aliases. To connect an account or use Actions, upgrade them to a private URL on the configure page and reinstall once.

### Local Instance

1. Start backend (or full dev stack)
2. In Stremio -> Addons -> **Add Addon URL**
3. Enter:

```text
http://localhost:7001/manifest.json
```

## Backend Environment Variables

Set backend env vars in `apps/backend/.env`.

| Variable                    | Required | Description                                                                      | Default                 |
| --------------------------- | -------- | -------------------------------------------------------------------------------- | ----------------------- |
| `PORT`                      | No       | Backend HTTP port                                                                           | `7001`                  |
| `FRONTEND_URL`              | No       | Configure site, used for redirects (`/:accountKey/configure`, OAuth callbacks)              | `https://stremlist.com` |
| `BACKEND_PUBLIC_URL`        | Yes\*    | Public URL of the backend, used for OAuth redirect URIs and Action links                    | request origin          |
| `SUPABASE_URL`              | Yes      | Supabase project URL                                                                        | -                       |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes      | Supabase service role key                                                                   | -                       |
| `R2_ACCOUNT_ID`             | Yes      | Cloudflare account ID used by the R2 S3 endpoint                                            | -                       |
| `R2_ACCESS_KEY_ID`          | Yes      | Bucket-scoped R2 API token access key                                                       | -                       |
| `R2_SECRET_ACCESS_KEY`      | Yes      | Bucket-scoped R2 API token secret                                                           | -                       |
| `R2_BUCKET`                 | Yes      | Private R2 cache bucket name                                                                | -                       |
| `CONNECTION_ENCRYPTION_KEY` | Yes\*    | 32 random bytes in base64 (`openssl rand -base64 32`); encrypts OAuth tokens. Never rotate it without re-encrypting `connections` | -                       |
| `TRAKT_CLIENT_ID`           | Yes\*    | Trakt API app client ID (public reads and OAuth with PKCE)                                  | -                       |
| `TRAKT_CLIENT_SECRET`       | No       | Only for Trakt apps created before 2026-10-01; new apps have none                           | -                       |
| `SIMKL_CLIENT_ID`           | Yes\*    | Simkl OAuth V2 app client ID                                                                | -                       |
| `SIMKL_CLIENT_SECRET`       | Yes\*    | Simkl OAuth V2 app client secret                                                            | -                       |
| `MDBLIST_CLIENT_ID`         | Yes\*    | MDBList OAuth app client ID                                                                 | -                       |
| `MDBLIST_CLIENT_SECRET`     | Yes\*    | MDBList OAuth app client secret                                                             | -                       |
| `TMDB_READ_ACCESS_TOKEN`    | Yes\*    | TMDB v4 read access token (Title ID resolution). `TMDB_API_KEY` (v3) also works             | -                       |
| `DISABLED_PROVIDERS`        | No       | Kill switch: comma-separated Provider IDs to turn off (e.g. `trakt,justwatch`). Their Lists keep serving the last cached Catalog | -                       |
| `CACHE_TTL_MINUTES`         | No       | How long a cached IMDb List is served before it is refreshed on the next request            | `30`                    |
| `REFRESH_COOLDOWN_SECONDS`  | No       | Minimum time between manual "Refresh now" requests per Account                              | `60`                    |
| `RESEND_API_KEY`            | No       | Resend API key for newsletter subscription endpoint                                         | -                       |
| `RESEND_AUDIENCE_ID`        | No       | Resend audience ID for newsletter subscription endpoint                                     | -                       |

\* Required for the Provider or feature that uses it. Without a Provider's credentials, its Connect button is hidden and its public reads fail.

### Provider app callback URLs

Register `${BACKEND_PUBLIC_URL}/oauth/{trakt|simkl|mdblist}/callback` in each Provider's developer settings. `http://localhost:7001/oauth/{provider}/callback` is registered too for local development without Portless (`PORTLESS=0`).

## Type Generation

To regenerate shared Supabase types:

```bash
pnpm generate:types
```

This updates `packages/shared/src/database.types.ts`.

The production R2 rollout and cleanup procedure is documented in
[`docs/r2-cache-migration.md`](docs/r2-cache-migration.md).

## License

ISC

## Disclaimer

This project is not affiliated with Stremio or with any of the services it reads lists from (IMDb, Trakt, Simkl, MDBList, JustWatch, SensCritique, Letterboxd).
