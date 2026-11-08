// Compares production with a local database rebuilt from supabase/migrations.
//
//   supabase db start && node .github/scripts/supabase-drift.mjs
//
// Checks the migration history, then the public schema: columns,
// constraints, indexes, functions, RLS, policies, grants and triggers.
// Production is read through the Management API in read-only transactions.
// Known differences live in supabase/drift-allowlist.json, each with a reason.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  compareMigrations,
  localMigrations,
  publishSummary,
  readOnlyQuery,
  remoteMigrations,
} from "./supabase-api.mjs";

const LOCAL_CONTAINER =
  process.env.LOCAL_DB_CONTAINER ?? "supabase_db_stremlist";

// Each section: the query, and the name a row is reported (and allowlisted) by.
const SECTIONS = {
  columns: {
    key: (r) => `${r.table_name}.${r.column_name}`,
    sql: `select table_name, column_name, data_type, column_default, is_nullable
      from information_schema.columns where table_schema = 'public'`,
  },
  constraints: {
    key: (r) => r.conname,
    sql: `select conrelid::regclass::text as table_name, conname,
        pg_get_constraintdef(oid) as definition
      from pg_constraint where connamespace = 'public'::regnamespace`,
  },
  indexes: {
    key: (r) => r.indexname,
    sql: `select tablename, indexname, indexdef from pg_indexes
      where schemaname = 'public'`,
  },
  functions: {
    key: (r) => r.proname,
    sql: `select p.proname, pg_get_function_identity_arguments(p.oid) as args,
        md5(pg_get_functiondef(p.oid)) as definition_md5, p.prosecdef,
        array_to_string(p.proconfig, ',') as config
      from pg_proc p where p.pronamespace = 'public'::regnamespace`,
  },
  rls: {
    key: (r) => r.relname,
    sql: `select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')`,
  },
  policies: {
    key: (r) => `${r.tablename}.${r.policyname}`,
    sql: `select tablename, policyname, permissive, roles::text as roles, cmd,
        qual, with_check
      from pg_policies where schemaname = 'public'`,
  },
  table_grants: {
    key: (r) => r.relname,
    sql: `select c.relname, r.rolname,
        string_agg(a.privilege_type, ',' order by a.privilege_type) as privileges
      from pg_class c
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      join pg_roles r on r.oid = a.grantee
      where c.relnamespace = 'public'::regnamespace
        and c.relkind in ('r', 'p', 'v', 'm')
        and r.rolname in ('anon', 'authenticated', 'service_role')
      group by 1, 2`,
  },
  function_grants: {
    key: (r) => r.proname,
    sql: `select p.proname, coalesce(r.rolname, 'PUBLIC') as grantee
      from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      left join pg_roles r on r.oid = a.grantee
      where p.pronamespace = 'public'::regnamespace
        and coalesce(r.rolname, 'PUBLIC') in ('anon', 'authenticated', 'service_role', 'PUBLIC')`,
  },
  triggers: {
    key: (r) => `${r.event_object_table}.${r.trigger_name}`,
    sql: `select event_object_table, trigger_name, event_manipulation, action_statement
      from information_schema.triggers where trigger_schema = 'public'`,
  },
};

function localQuery(sql) {
  const wrapped = `select coalesce(json_agg(t), '[]') from (${sql}) t`;
  const output = execFileSync(
    "docker",
    [
      "exec",
      "-i",
      LOCAL_CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: wrapped, encoding: "utf8" },
  );
  return JSON.parse(output);
}

const canonical = (row) =>
  JSON.stringify(Object.fromEntries(Object.entries(row).sort()));

const allowlist = JSON.parse(
  readFileSync("supabase/drift-allowlist.json", "utf8"),
);
const allowed = new Map(allowlist.map(({ name, reason }) => [name, reason]));
const usedAllowlist = new Set();

const lines = [];
let failures = 0;

const history = compareMigrations(localMigrations(), await remoteMigrations());
for (const m of history.pending) {
  lines.push(`- history: ${m.version}_${m.name} is not applied in production`);
  failures++;
}
for (const m of history.unknown) {
  lines.push(`- history: ${m.version}_${m.name} is applied but has no file`);
  failures++;
}
for (const m of history.renamed) {
  lines.push(
    `- history: ${m.version} is ${m.remoteName} in production, ${m.name} in the repo`,
  );
  failures++;
}

for (const [section, { key, sql }] of Object.entries(SECTIONS)) {
  const local = new Map(localQuery(sql).map((r) => [canonical(r), r]));
  const remote = new Map(
    (await readOnlyQuery(sql)).map((r) => [canonical(r), r]),
  );
  const report = (row, where) => {
    const name = key(row);
    if (allowed.has(name)) {
      usedAllowlist.add(name);
      return;
    }
    lines.push(`- ${section}: ${name} ${where}: \`${canonical(row)}\``);
    failures++;
  };
  for (const [id, row] of remote)
    if (!local.has(id)) report(row, "only in production");
  for (const [id, row] of local)
    if (!remote.has(id)) report(row, "only in the migrations");
}

const stale = [...allowed.keys()].filter((name) => !usedAllowlist.has(name));
publishSummary("Supabase drift: production", [
  ...(lines.length > 0 ? lines : ["No difference outside the allowlist."]),
  ...stale.map(
    (name) => `- note: allowlist entry \`${name}\` matches nothing; remove it.`,
  ),
  "",
  failures > 0
    ? "Status: DRIFT. Fix with a migration, or record a known difference in supabase/drift-allowlist.json."
    : "Status: production matches supabase/migrations.",
]);
if (failures > 0) process.exitCode = 1;
