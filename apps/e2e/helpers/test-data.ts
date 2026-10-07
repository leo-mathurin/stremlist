// Real IMDb ids used by the E2E suite. Tests hit live IMDb through the
// backend, so assertions stay structural (ordering invariants, counts, id
// shapes) instead of pinning exact titles that could change over time.

// Small public watchlist (~19 items) — one of the ids the backend stress test
// already exercises, kept small so live fetches stay fast.
export const PUBLIC_USER = process.env.E2E_IMDB_USER_ID ?? "ur102135398";

// Second public watchlist for multi-catalog scenarios.
export const PUBLIC_USER_2 = process.env.E2E_IMDB_USER_ID_2 ?? "ur102551738";

// Long-standing public IMDb list ("Top 100 Greatest Movies of All Time").
export const PUBLIC_LIST = process.env.E2E_IMDB_LIST_ID ?? "ls055592025";

// Syntactically valid ids that do not exist. IMDb user ids are ~9 digits;
// a 13-digit id is far outside the allocated range.
export const UNKNOWN_USER = "ur9999999999999";
export const UNKNOWN_LIST = "ls9999999999999";
export const MALFORMED_USER = "not-an-imdb-user";

// Account whose watchlist is deliberately kept private for these tests
// (maintainer-owned). The p-handle resolves to the same account, covering the
// handle-resolution path for private sources too.
export const PRIVATE_USER =
  process.env.E2E_PRIVATE_IMDB_USER_ID ?? "ur198342247";
export const PRIVATE_P_HANDLE = "p.e4ialbfdp3rntdahbslk5yzovm";

// Synthetic IMDb watchlist behind the deterministic catalog scenarios. Its
// Catalog is seeded in R2, so the backend never asks IMDb for it.
export const CATALOG_FIXTURE_USER = "ur9999999999998";
// A second synthetic watchlist, for merged Lists.
export const CATALOG_FIXTURE_USER_2 = "ur9999999999997";

// Cleanup must stay scoped to identities explicitly owned by this E2E run.
// The local Supabase stack may share a persisted volume with development.
// These are the Legacy aliases that tests may create; Accounts with generated
// IDs are scoped by the run start (see helpers/db.ts).
export const E2E_USER_IDS = [
  CATALOG_FIXTURE_USER,
  CATALOG_FIXTURE_USER_2,
  PUBLIC_USER,
  PUBLIC_USER_2,
  UNKNOWN_USER,
  PRIVATE_USER,
  MALFORMED_USER,
] as const;

// No stable private ls list is available; provide one via env to enable the
// private-list test.
export const PRIVATE_LIST = process.env.E2E_PRIVATE_IMDB_LIST_ID;

// p-handle that must resolve to a canonical ur id (IMDb founder's profile).
export const P_HANDLE = "p.colneedham";
