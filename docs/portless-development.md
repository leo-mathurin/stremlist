# Portless development

This repo pins [Portless 0.15.6](https://github.com/vercel-labs/portless) and uses
Node.js 24 for development and CI. Production builds still use the configured
Vercel backend URL; the proxy described here is only for the dev server.

## Start and share

1. Install dependencies with `pnpm install` and decrypt `apps/backend/.env`.
2. Run `pnpm exec portless proxy start` once in an interactive terminal. Portless
   creates and trusts a local certificate authority and starts its HTTPS proxy.
   Standard port 443 and certificate trust may require sudo. A non-interactive
   first run fails with setup instructions instead of waiting for a prompt.
3. Run `pnpm dev` for local development, or `pnpm dev:tailnet` to share the frontend.
4. Run `pnpm exec portless list` to see the current local and tailnet URLs.

Tailscale must be installed, connected, and have HTTPS certificates enabled.
Its HTTPS URL is trusted on the Mac without installing the tower's local CA.
Sharing uses Tailscale Serve, accessible to your tailnet. We do not enable Funnel
or ngrok. Existing Serve routes are preserved: Portless picks the next available
HTTPS port (443, then 8443, 8444, …). Use the printed URL; the port can change
between runs as other apps start or stop.

`PORTLESS_TAILSCALE=1 pnpm dev` also enables sharing. The backend Turbo tasks
exclude sharing environment variables so only the frontend needs a tailnet route.
Use `PORTLESS_TAILSCALE=0 pnpm dev` for local-only mode if your shell enables
sharing globally. Start through the root Turbo scripts for this behavior.

## How requests travel

```text
Mac browser → frontend tailnet HTTPS URL → Vite
                                            └─ /api → Portless → backend
```

The package-level `portless` configuration names the frontend `stremlist` and
the backend `api.stremlist`, and runs each package's `dev:app` script. Both get
dynamic ports. The backend honors Portless's `PORT` and `HOST`; Portless injects
Vite's port and host flags automatically.

Linked worktrees automatically prepend a sanitized branch name to both local
hostnames. Vite calls `portless get api.stremlist` from its own worktree to find
the matching backend, including the proxy's configured port and TLS mode. Keep
the backend package's name and this lookup in sync if renaming it.

The browser calls relative `/api` URLs. Vite strips that prefix and sets
`changeOrigin: true` so Portless routes by the backend host, avoiding a proxy loop.
Portless supplies `NODE_EXTRA_CA_CERTS` so Vite trusts the backend's local HTTPS
certificate. Addon links become absolute URLs on the browser's current origin;
the `/api/:userId/configure` redirect returns to that same frontend.

Production builds and the existing E2E harness keep their explicit
`VITE_BACKEND_URL`. The E2E harness starts Vite and the backend directly on its
own ports, without Portless or Tailscale.

## Useful settings

| Setting or command                          | When it helps                                                                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec portless get stremlist`          | Print this worktree's local frontend URL.                                                                                               |
| `pnpm exec portless get api.stremlist`      | Print this worktree's local backend URL.                                                                                                |
| `DEV_BACKEND_URL`                           | Override the internal proxy target, e.g. an API running in Docker. Put it in `apps/frontend/.env.local` or export it before starting.   |
| `VITE_BACKEND_URL`                          | Explicit browser-facing API URL for production or direct Vite/E2E runs. Portless development uses `/api` even if an old value exists.   |
| `pnpm exec portless proxy start -p 1355`    | Use an unprivileged proxy port. Initial CA trust can still require sudo.                                                                |
| `PORTLESS_STATE_DIR`                        | Isolate proxy state when needed; both apps must use the same state directory. Choose a different proxy port if another proxy is active. |
| `PORTLESS_SYNC_HOSTS=0`                     | Disable local hosts-file changes when the browser already resolves `.localhost`.                                                        |
| `pnpm exec portless hosts sync`             | Repair local hostname resolution, particularly in Safari. This affects the machine running Portless, not other tailnet devices.         |
| `pnpm exec portless trust`                  | Repair trust for the local CA. Tailnet HTTPS uses Tailscale certificates separately.                                                    |
| `PORTLESS=0 pnpm dev`                       | Bypass Portless and run the app commands directly. Backend defaults to 7001, Vite to 5173.                                              |
| `pnpm --filter @stremlist/backend dev:app`  | Start just the backend directly.                                                                                                        |
| `pnpm --filter @stremlist/frontend dev:app` | Start just Vite directly. Without an explicit API URL, `/api` proxies to localhost:7001.                                                |

Portless remembers proxy port, TLS, TLD, and LAN settings across restarts. Start
with `portless list` and `portless doctor` when a URL differs from expectations.
Turbo forwards the relevant `PORTLESS_*` settings and proxy overrides to dev tasks.

Other documented options are optional for this repo:

- **LAN mode** (`--lan`) uses mDNS `.local` names for devices on the same LAN.
  It is separate from tailnet sharing; we use `--tailscale` for the Mac.
- **Custom TLDs** (`--tld test`) and **wildcard hosts** (`--wildcard`) help with
  subdomain-based apps. Stremlist does not need them.
- **Fixed app ports** (`--app-port`, `PORTLESS_APP_PORT`, or `appPort`) are useful
  for external tools requiring one port. Avoid a shared fixed port for both apps
  or multiple worktrees; dynamic assignment prevents collisions.
- **Custom certificates** (`--cert` / `--key`) can replace the local CA.
  `--no-tls` disables local HTTPS, but HTTPS is useful for clipboard access and HMR.
- **OS service** (`portless service install`) keeps the shared proxy available
  after reboot. It does not start the application dev processes.
- **Aliases** (`portless alias <name> <port>`) expose a separately managed service
  such as a Docker container through the proxy.

## Verify and stop

Open the frontend URL and check `/api/health` for `{"status":"ok","database":"up"}`.
`/api/manifest.json` should return an addon manifest.

Stop the owning `pnpm dev` / `pnpm dev:tailnet` process with Ctrl-C. Portless
removes its app routes and Serve registration; its shared proxy can remain up.
Do not run `proxy stop`, `prune`, or `clean` while other projects use it. `prune`
terminates orphaned app processes; `clean` removes shared state, local CA trust,
and hosts entries. `doctor` is read-only and is the first troubleshooting step.

References reviewed: [README](https://github.com/vercel-labs/portless#readme),
[configuration](https://portless.sh/configuration),
[commands](https://portless.sh/commands), and the installed CLI's `--help`.
