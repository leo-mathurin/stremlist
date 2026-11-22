# Verification

Before handing off a behavior change, run the local [verify-stremlist skill](.agents/skills/verify-stremlist/SKILL.md). Use its feature map to select user journeys and its delivery criteria to report evidence and coverage gaps. A blocked or skipped check remains unverified.

## Stale toolkit recordings

When a change makes a toolkit recording stale (`REPLAY_STALE` or a missing recording), record it again in the same change. Do not leave it for someone else.

1. Run `bun run test:toolkit:record` two times from the repository root. The second run must make zero model calls.
2. Run `bun run test:toolkit:replay`.
3. Commit the new `apps/e2e/.e2e/cache/*.json` files with the change. Never edit a recording by hand.

The Mac, oracle-dev and tour each have the ChatGPT login for recording. If the login is missing or expired on the machine you use, run `bun run --cwd apps/e2e e2e login openai --device` and give Léo the URL and code. Read [the E2E README](apps/e2e/README.md) for the cache rules.

# Changelog

Each release adds one entry to `apps/frontend/src/content/changelog.json`. The CI `version-bump` job writes it: one line for each `feat`, `fix` and `perf` commit of the merge, taken from the commit subject. Users read these lines on `/changelog`, so do not add release entries by hand.

- When the subject does not tell a user what changed, add a `Changelog: <sentence for users>` line to the commit body. It replaces the subject. Keep each line below 100 characters. Start a continuation line with two spaces.
- When users cannot see the change, add `Changelog: skip` to the commit body. A release with no line left gets one maintenance line.
- To correct a published entry, edit the JSON file in a pull request.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# Linear

- Use the Composio connection `stremlist`. The Linear team is `STR`.
- Before you create a Linear issue for this repository, read and apply
  [create-linear-issue](.agents/skills/create-linear-issue/SKILL.md). This
  includes issues that you create during other work, such as PR preparation
  or audit follow-up.
