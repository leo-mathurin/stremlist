import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createdExtensions,
  localMigrations,
  migrationSql,
} from "./supabase-api.mjs";

test("finds the extensions a migration creates", () => {
  assert.deepEqual(
    createdExtensions(`
      CREATE EXTENSION IF NOT EXISTS pg_cron;
      create extension "pgcrypto" with schema extensions;
      CREATE   EXTENSION
        vector;
    `),
    ["pg_cron", "pgcrypto", "vector"],
  );
});

test("ignores extensions in comments", () => {
  assert.deepEqual(
    createdExtensions(`
      -- CREATE EXTENSION pg_cron;
      /* create extension
         vector; */
      SELECT 1;
    `),
    [],
  );
});

test("pg_cron is created before the accounts rename", () => {
  const migrations = localMigrations();
  const rename = migrations.findIndex(
    (m) => m.name === "accounts_providers_connections",
  );
  const firstCron = migrations.findIndex((m) =>
    createdExtensions(migrationSql(m)).includes("pg_cron"),
  );
  assert.ok(rename > 0, "the rename migration exists");
  assert.ok(firstCron >= 0, "a migration creates pg_cron");
  assert.ok(
    firstCron < rename,
    `${migrations[firstCron].version} must come before ${migrations[rename].version}`,
  );
});
