// Compares supabase/migrations with the production history table.
//
//   node .github/scripts/supabase-migrations.mjs plan
//     Lists the migrations the deploy will apply. Fails when production has a
//     migration the repo does not know, so a push never runs on a history it
//     cannot explain.
//   node .github/scripts/supabase-migrations.mjs verify
//     Run after `supabase db push`: fails unless the history matches the repo.
import {
  compareMigrations,
  localMigrations,
  publishSummary,
  remoteMigrations,
} from "./supabase-api.mjs";

const mode = process.argv[2];
if (mode !== "plan" && mode !== "verify") {
  throw new Error("Usage: supabase-migrations.mjs <plan|verify>");
}

const { pending, unknown, renamed } = compareMigrations(
  localMigrations(),
  await remoteMigrations(),
);

const blocking = [
  ...unknown.map(
    (m) =>
      `- BLOCKING: ${m.version}_${m.name} is applied in production but has no file in supabase/migrations.`,
  ),
  ...renamed.map(
    (m) =>
      `- BLOCKING: ${m.version} is \`${m.remoteName}\` in production but \`${m.name}\` in the repo.`,
  ),
];

if (mode === "plan") {
  publishSummary("Supabase migrations: plan", [
    pending.length === 0
      ? "No migration to apply."
      : `Migrations to apply (${pending.length}):`,
    ...pending.map(
      (m) =>
        `- ${m.version}_${m.name}${m.outOfOrder ? " (older than the latest applied migration; applied with --include-all)" : ""}`,
    ),
    ...blocking,
    "",
    blocking.length > 0
      ? "Status: BLOCKED. Repair the history (see docs/production-deploy.md) before the deploy can continue."
      : "Status: ready.",
  ]);
  if (blocking.length > 0) process.exitCode = 1;
} else {
  const missing = pending.map((m) => `- NOT APPLIED: ${m.version}_${m.name}`);
  const problems = [...missing, ...blocking];
  publishSummary("Supabase migrations: verify", [
    ...problems,
    problems.length > 0
      ? "Status: FAILED. Production history differs from the repo after db push."
      : "Status: production history matches supabase/migrations.",
  ]);
  if (problems.length > 0) process.exitCode = 1;
}
