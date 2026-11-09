// Read-only access to the production Supabase project through the
// Management API, shared by the deploy scripts.
import { appendFileSync, readdirSync } from "node:fs";

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
