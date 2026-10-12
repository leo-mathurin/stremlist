# Stremlist

![Stremlist OG Image](https://stremlist.com/og-image.png)

Stremlist is a Stremio addon that shows your watchlists and lists from IMDb, Trakt, Simkl, MDBList, JustWatch and SensCritique as catalogs in Stremio, so you can browse your saved movies and TV shows directly inside Stremio. With a connected Trakt, Simkl or MDBList account, it can also add titles to your watchlist, mark them as watched and rate them from Stremio.

The vocabulary used in the code and in these docs (Account, Provider, Source list, List, Catalog, Title, Connection, Action) is defined in [`CONTEXT.md`](CONTEXT.md). Architecture decisions and Provider constraints are in [`docs/architecture.md`](docs/architecture.md).

## Features

- IMDb, Trakt, Simkl, MDBList, JustWatch and SensCritique lists, including merged Lists
- Catalog sorting, genre/decade/runtime/rating filters, search and extra home catalogs
- A "New titles" catalog of entries detected after the first complete synchronization
- Optional Trakt, Simkl and MDBList Actions and RPDB rating posters
- Cache-first serving with automatic refresh and "Refresh now"

Reinstall after changing manifest catalogs or dropdown options. Saved filters also
apply to search and extra catalogs; the Stremio dropdown adds one temporary filter
or overrides the sort. Shuffle stays stable within a cache generation.

`apps/backend` is the Hono API, `apps/frontend` is the Vite/React UI, and
`packages/shared` holds shared types and rules. Both apps deploy on Vercel.
Supabase stores configuration, encrypted Connections and the Title ID cache;
Cloudflare R2 stores catalog generations, Connection state and detection history.

## Using the Addon

1. Open [Configure](https://stremlist.com/configure), paste a list link or connect a Provider.
2. Save and install the generated Addon URL in Stremio.
3. Keep the URL: it is the only credential for your configuration.

Legacy `ur…` installs still serve public Lists. Upgrade on the configure page
and reinstall to connect a Provider or use Actions.

## Getting Started

### Prerequisites

- Node.js 24+ for development with Portless (`.node-version`)
- Bun 1.4+ (`packageManager` in `package.json`)

### Install

```bash
bun install
```

### Run in Development

Decrypt the backend environment first (see below).

The database selected by `apps/backend/.env` must have all migrations in
`supabase/migrations` applied. `bun run dev` does not migrate it. Use
`bun run dev:local` for an isolated stack; do not migrate a shared database while
an older backend still expects its previous schema. Restart after changing env.

Run `bunx portless proxy start` once in an interactive terminal to initialize
HTTPS and trust its local certificate authority (may require sudo).

Then run:

```bash
bun run dev             # both apps through Portless
bun run dev:local       # start local database + cache, then both apps
bun run dev:tailnet     # both apps; share the frontend over Tailscale HTTPS
bun run dev:backend     # backend only
bun run dev:frontend    # frontend only (requires a running backend)
bunx portless list
```

`bun dev:local` requires Docker running and the Supabase CLI installed. It
creates or reuses an isolated stack in `.dev.local`, applies pending migrations,
and starts a local S3-compatible cache. The backend receives the local connection
settings for that process; `.env` is not rewritten. Provider credentials still
come from `apps/backend/.env`. Stop an existing `bun dev` before switching modes.
The containers and their data remain available after you stop the dev servers.

Use the printed URLs or `bunx portless list`: worktrees add a branch prefix and
proxy ports can vary. The browser calls `/api` on the frontend origin; Vite
forwards it to the matching backend. For tailnet access, use the printed
Tailscale HTTPS URL (requires Tailscale and HTTPS certificates enabled).

- `DEV_BACKEND_URL` overrides Vite's internal proxy target.
- `VITE_BACKEND_URL` sets the API URL for production and direct Vite/E2E runs.
- `PORTLESS=0 bun run dev` bypasses the proxy (backend 7001, frontend 5173).
- `bunx portless doctor` diagnoses routing; `bunx portless trust` repairs CA trust.

Stop the owning dev process with Ctrl-C. Avoid stopping or cleaning the shared
Portless proxy while other projects use it.

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
bun run build
bun run typecheck
bun run lint
bun run test
bun run format
bun run format:check
```

### Remote cache

Turborepo shares task outputs through [Vercel Remote Cache](https://turborepo.dev/docs/core-concepts/remote-caching),
so CI and local runs can reuse each other's builds and tests. To use it locally,
log in and link the repo to the `lelemathrins-projects` Vercel team once:

```bash
bunx turbo login
bunx turbo link
```

CI authenticates with OpenID Connect instead of a stored token. It needs:

- A Turborepo CLI OIDC policy for this repository on the Vercel team
  (**Settings → Build and Deployment → OIDC Policies for CLI Access**)
- A `TURBO_TEAM` GitHub Actions repository variable set to the team slug

Without the variable, on pull requests from forks, or if the token exchange
fails, CI runs with only a local cache.

## Backend Environment Variables

Set backend env vars in `apps/backend/.env`.

| Variable                    | Required | Description                                                                                                                                               | Default                 |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `PORT`                      | No       | Backend HTTP port                                                                                                                                         | `7001`                  |
| `FRONTEND_URL`              | No       | Configure site, used for redirects (`/:accountKey/configure`, OAuth callbacks)                                                                            | `https://stremlist.com` |
| `BACKEND_PUBLIC_URL`        | Yes\*    | Public URL of the backend, used for OAuth redirect URIs and Action links                                                                                  | request origin          |
| `SUPABASE_URL`              | Yes      | Supabase project URL                                                                                                                                      | -                       |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes      | Supabase service role key                                                                                                                                 | -                       |
| `R2_ACCOUNT_ID`             | Yes      | Cloudflare account ID used by the R2 S3 endpoint                                                                                                          | -                       |
| `R2_ACCESS_KEY_ID`          | Yes      | Bucket-scoped R2 API token access key                                                                                                                     | -                       |
| `R2_SECRET_ACCESS_KEY`      | Yes      | Bucket-scoped R2 API token secret                                                                                                                         | -                       |
| `R2_BUCKET`                 | Yes      | Private R2 cache bucket name                                                                                                                              | -                       |
| `CONNECTION_ENCRYPTION_KEY` | Yes\*    | 32 random bytes in base64 (`openssl rand -base64 32`); encrypts OAuth tokens. Never rotate it without re-encrypting `connections`                         | -                       |
| `TRAKT_CLIENT_ID`           | Yes\*    | Trakt API app client ID (public reads and OAuth with PKCE)                                                                                                | -                       |
| `TRAKT_CLIENT_SECRET`       | No       | Only for Trakt apps created before 2026-10-01; new apps have none                                                                                         | -                       |
| `SIMKL_CLIENT_ID`           | Yes\*    | Simkl OAuth V2 app client ID                                                                                                                              | -                       |
| `SIMKL_CLIENT_SECRET`       | Yes\*    | Simkl OAuth V2 app client secret                                                                                                                          | -                       |
| `MDBLIST_CLIENT_ID`         | Yes\*    | MDBList OAuth app client ID                                                                                                                               | -                       |
| `MDBLIST_CLIENT_SECRET`     | Yes\*    | MDBList OAuth app client secret                                                                                                                           | -                       |
| `TMDB_READ_ACCESS_TOKEN`    | Yes\*    | TMDB v4 read access token (Title ID resolution). `TMDB_API_KEY` (v3) also works                                                                           | -                       |
| `DISABLED_PROVIDERS`        | No       | Kill switch: comma-separated Provider IDs to turn off (e.g. `trakt,justwatch`). No request goes to them; their Lists keep serving the last cached Catalog | -                       |
| `CACHE_TTL_MINUTES`         | No       | How long a cached IMDb List is served before it is refreshed on the next request                                                                          | `30`                    |
| `REFRESH_COOLDOWN_SECONDS`  | No       | Minimum time between manual "Refresh now" requests per Account                                                                                            | `60`                    |
| `RESEND_API_KEY`            | No       | Resend API key for newsletter subscription endpoint                                                                                                       | -                       |
| `RESEND_AUDIENCE_ID`        | No       | Resend audience ID for newsletter subscription endpoint                                                                                                   | -                       |

\* Required for the Provider or feature that uses it. Without a Provider's credentials, its Connect button is hidden and its public reads fail.

### Provider app callback URLs

Register `${BACKEND_PUBLIC_URL}/oauth/{trakt|simkl|mdblist}/callback` in each Provider's developer settings. `http://localhost:7001/oauth/{provider}/callback` is registered too for local development without Portless (`PORTLESS=0`).

## Type Generation

To regenerate shared Supabase types:

```bash
bun run generate:types
```

This updates `packages/shared/src/database.types.ts`.

## R2 setup

Create a private Standard R2 bucket, a bucket-scoped Object Read & Write token,
and a 30-day object-expiration lifecycle rule. Set the R2 variables above on the
backend only. Leave `R2_ENDPOINT` unset in production; it is for local
S3-compatible stores. Cache generations populate on demand.

## End-to-end and load tests

See [E2E setup and toolkit recordings](apps/e2e/README.md) and
[local load testing](apps/backend/stress/README.md).

## License

ISC

## Disclaimer

This project is not affiliated with Stremio or with any of the services it reads lists from (IMDb, Trakt, Simkl, MDBList, JustWatch, SensCritique, Letterboxd). Their names and logos are trademarks of their owners and are used only to say that Stremlist works with them. IMDb and all related logos are trademarks of IMDb.com, Inc. or its affiliates.
