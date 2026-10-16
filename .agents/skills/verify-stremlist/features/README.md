# Stremlist verification map

Read the matching feature before driving the app. Start with [the skill](../SKILL.md) for launch, isolation, evidence, and cleanup.

- [Onboarding and account access](onboarding.md) covers Home, pasted links, returning users, public pages, and newsletter UI.
- [Configuration and Merged Lists](configuration.md) covers saved Lists, ordering, filtering, merges, and concurrent edits.
- [Providers and Actions](providers.md) covers Connections, authorization recovery, private URLs, and outbound Actions.
- [Catalogs and installation](catalogs.md) covers previews, New titles, addon responses, and Stremio installation.
- [Refresh and sync status](refresh.md) covers refresh, cooldown, stale catalogs, and per-List recovery.

UI fixtures seed `sl_E2eFixtureAccount00001` with `Test catalog` and Legacy alias `ur99123456`. They exist only inside the toolkit's intercepted context. Integration fixtures seed the disposable database per spec. Do not paste these IDs into a separate browser and assume the Account exists.

Record a result per feature and entry point. Use `pass`, `fail`, `blocked`, or `not run`. Missing seed data is a failed journey with the missing precondition recorded, not permission to omit an assertion. Running one feature does not verify the rest of the map.
