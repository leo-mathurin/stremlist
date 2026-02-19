# Stremlist

![Stremlist OG Image](https://stremlist.com/og-image.png)

Stremlist is a Stremio addon that turns your IMDb watchlist into a Stremio catalog, so you can browse your saved movies and TV shows directly inside Stremio.
## Features

- Browse IMDb watchlist items in Stremio
- Supports both movies and series
- Supports sorting by title, year, rating, and runtime
- Simple install flow through a hosted configuration UI
- Lightweight backend with Supabase for user management and watchlist caching
- Monorepo architecture with Turborepo (`apps` + `packages`)

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

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 10+

### Install

```bash
pnpm install
```

### Run in Development

Run both apps:

```bash
pnpm dev
```

Run only one app:

```bash
pnpm dev:backend
pnpm dev:frontend
```

Default local URLs:

- Backend: `http://localhost:7001`
- Frontend: Vite default (`http://localhost:5173` unless overridden)

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

1. Open Stremio -> Addons
2. Click **Add Addon URL**
3. Enter: `[YOUR_DEPLOYED_BACKEND_URL]/manifest.json`
4. Configure with your IMDb user ID

### Local Instance

1. Start backend (or full dev stack)
2. In Stremio -> Addons -> **Add Addon URL**
3. Enter:

```text
http://localhost:7001/manifest.json
```

## Backend Environment Variables

Set backend env vars in `apps/backend/.env`.

| Variable | Required | Description | Default |
| --- | --- | --- | --- |
| `PORT` | No | Backend HTTP port | `7001` |
| `FRONTEND_URL` | No | URL used for `/:userId/configure` redirect | `https://stremlist.com` |
| `SUPABASE_URL` | Yes | Supabase project URL | - |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key | - |
| `RESEND_API_KEY` | No | Resend API key for newsletter subscription endpoint | - |
| `RESEND_AUDIENCE_ID` | No | Resend audience ID for newsletter subscription endpoint | - |

## Type Generation

To regenerate shared Supabase types:

```bash
pnpm generate:types
```

This updates `packages/shared/src/database.types.ts`.

## License

ISC

## Disclaimer

This project is not affiliated with IMDb or Stremio.