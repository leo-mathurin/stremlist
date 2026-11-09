// Read-only access to the production Supabase project through the
// Management API, shared by the deploy scripts.
import { appendFileSync, readdirSync, readFileSync } from "node:fs";

const PROJECT_REF = "igbmxubzxjfdbgmawrtr";

function token() {
  const value = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (!value) throw new Error("SUPABASE_ACCESS_TOKEN is not set");
  return value;
}

// `read_only: true` runs the query in a read-only transaction, so these
// scripts cannot change production even if a query is wrong.
async function readOnlyQuery(query) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, read_only: true }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Management API query failed with ${response.status}: ${await response.text()}`,
    );
  }
  return response.json();
}

export function localMigrations(dir = "supabase/migrations") {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => {
      const match = /^(\d+)_(.+)\.sql$/.exec(file);
      if (!match) throw new Error(`Unexpected migration file name: ${file}`);
      return { version: match[1], name: match[2] };
    })
    .sort((a, b) => a.version.localeCompare(b.version));
}

// Extensions that a migration creates. `db push --dry-run` does not run the
// SQL, so without this check an extension that production cannot install
// would only fail in the middle of the push.
export function createdExtensions(sql) {
  const code = sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const names = new Set();
  for (const match of code.matchAll(
    /\bcreate\s+extension\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?/gi,
  )) {
    names.add(match[1].toLowerCase());
  }
  return [...names].sort();
}

export function migrationSql({ version, name }, dir = "supabase/migrations") {
  return readFileSync(`${dir}/${version}_${name}.sql`, "utf8");
}

// Names come from createdExtensions, so they are [a-z0-9_] only.
export async function availableExtensions(names) {
  if (names.length === 0) return [];
  const list = names.map((name) => `'${name}'`).join(", ");
  return readOnlyQuery(
    `select name, default_version, installed_version from pg_available_extensions where name in (${list}) order by name`,
  );
}

export async function remoteMigrations() {
  return readOnlyQuery(
    "select version, name from supabase_migrations.schema_migrations order by version",
  );
}

// pending: in the repo, not applied. unknown: applied, but no file in the
// repo. renamed: same version, different name.
export function compareMigrations(local, remote) {
  const remoteByVersion = new Map(remote.map((m) => [m.version, m.name]));
  const localByVersion = new Map(local.map((m) => [m.version, m.name]));
  const latestApplied = remote.at(-1)?.version ?? "";
  return {
    pending: local
      .filter((m) => !remoteByVersion.has(m.version))
      .map((m) => ({ ...m, outOfOrder: m.version < latestApplied })),
    unknown: remote.filter((m) => !localByVersion.has(m.version)),
    renamed: local
      .filter(
        (m) =>
          remoteByVersion.has(m.version) &&
          remoteByVersion.get(m.version) !== m.name,
      )
      .map((m) => ({ ...m, remoteName: remoteByVersion.get(m.version) })),
  };
}

export function publishSummary(title, lines) {
  const text = [`## ${title}`, "", ...lines, ""].join("\n");
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  }
}
