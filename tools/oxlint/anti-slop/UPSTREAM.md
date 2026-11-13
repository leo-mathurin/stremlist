# Anti-slop provenance

Source: https://github.com/dmmulroy/anti-slop

Revision: `13909c9e07590f5a85d93c62712259fe14a883f7` (retrieved 2026-11-13).

The eight enabled rules, their tests, and their local helpers are copied from `src/`. The MIT license is kept. Imports use `vite-plus/lint/plugins` and `vite-plus/lint/plugins-dev`, so the API matches the Oxlint that Vite+ bundles. `index.ts` registers only these rules. No rule implementation is changed.

The policy is in the root `vite.config.ts`. These upstream rules are intentionally omitted:

- `no-unknown-parameters`, `no-unknown-returns`, `no-runtime-typeof` and `no-unsafe-dictionary-type`: they reject valid boundary validation of provider responses and request bodies.
- `no-module-mocking`: the backend tests mock modules on purpose.
- `no-conditional-empty-object-spread`: omitting a field is not the same as setting it to `undefined` for Supabase and provider payloads.
- `no-array-filter-map` and `no-shape-in-symbol-names`: style rules with no correctness benefit here.
- `require-safety-comment-for-type-assertion` and `require-readable-spacing`: Oxfmt owns whitespace, and comments explain why, not what.

To update, stage a new upstream revision separately, compare it with this revision, keep the local policy, copy the matching tests and license, and update this file. Run `bun run test:tooling` after the update.
