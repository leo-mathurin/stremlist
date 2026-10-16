# Onboarding and account access

A visitor builds a new install from a Provider link or returns to an existing Account with its Addon URL.

## Sub-features

- `onboarding.new` detects a Provider, validates the link, and creates a private Account on Save.
- `onboarding.return` opens an Addon URL or an old `?userId` link without creating a replacement Account.
- `onboarding.errors` preserves invalid input and offers recovery from a failed configuration lookup.
- `onboarding.public` navigates Home, Terms, Changelog, and unknown routes. Newsletter UI validates, submits, and retries.

## How to get to it (user POV)

Open `/`. Paste into `Paste a link to a watchlist or list`, or choose `Build my Stremlist`. Returning users choose `Open it` and fill `Your Addon URL`. Existing links can open `/configure?account=...` or `/?userId=...` directly. Footer links reach public pages and the newsletter field is `your@email.com`.

## Driving it with toolkit and Playwright

Preconditions: use the skill's UI replay fixtures or the disposable integration stack. Live validation requires the public fixtures from `apps/e2e/helpers/test-data.ts`.

- Run `bun run test:toolkit:replay`. `toolkit/home.e2e.ts`, `ui.e2e.ts`, `configuration-recovery.e2e.ts`, and `account-newsletter.e2e.ts` drive these entry points. Require the Account URL, installation choices, captured create request, and errors asserted by the specs.
- For real onboarding storage and validation, run `CI=1 bun run --filter @stremlist/e2e test:e2e --project=live-smoke tests/home-onboarding.spec.ts --trace on`. Require `Your Stremlist is ready`, a generated `sl_` Account ID, and the second configuration read matching the pasted List.
- For invalid input and returning users, run `CI=1 bun run --filter @stremlist/e2e test:e2e --project=local tests/home-onboarding.spec.ts --trace on`. Require no resolution request for garbage and the existing configuration for a Legacy alias.

## Gotchas

- A failed existing-Account lookup must not become a new setup. Preserve this assertion.
- A toolkit newsletter success proves a request and visible response. It sends no mail.
- Public IMDb state can change. Record an unavailable or private live fixture as a failure with its cause.
