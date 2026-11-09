// Builds and publishes the production backend and frontend at one commit.
//
//   node .github/scripts/vercel-release.mjs build <sha>
//     Creates a production deployment of each project from the GitHub commit,
//     without custom domains, and waits until both are READY. Writes
//     `backend=<id>` and `frontend=<id>` to $GITHUB_OUTPUT.
//   node .github/scripts/vercel-release.mjs publish <sha> <backend-id> <frontend-id>
//     Run after the migrations: smoke-tests the backend deployment on its own
//     URL, then promotes the backend and the frontend to their domains and
//     checks that the domains serve them.
//
// Vercel's Git integration does not build main (vercel.json sets
// git.deploymentEnabled.main to false), so these deployments are the only
// way a commit reaches production.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { publishSummary } from "./supabase-api.mjs";

const TEAM = "team_BwkfpbaBngrjgP4YErFMyalz";
const REPO = { org: "leo-mathurin", repo: "stremlist" };
const APPS = {
  backend: {
    project: "prj_fVi6V61cW0jAnYhC7FJLOAH0Xzug",
    name: "stremlist-backend",
    rootDirectory: "apps/backend",
    domain: "api.stremlist.com",
  },
  frontend: {
    project: "prj_mfYFWq0aaOF7c8NLhM6AXZddFVz5",
    name: "stremlist-frontend",
    rootDirectory: "apps/frontend",
    domain: "stremlist.com",
  },
};
const POLL_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function vercel(path, { body, query = "", allowNotFound = false } = {}) {
  const token = process.env.VERCEL_TOKEN?.trim();
  if (!token) throw new Error("VERCEL_TOKEN is not set");
  const method = body ? "POST" : "GET";
  const response = await fetch(
    `https://api.vercel.com${path}?teamId=${TEAM}${query ? `&${query}` : ""}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (response.status === 404 && allowNotFound) return {};
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Vercel ${method} ${path}: HTTP ${response.status} ${text}`,
    );
  }
  return text ? JSON.parse(text) : {};
}

async function poll(read, ready, attempts, timeoutMessage) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await read();
    if (ready(value)) return value;
    await sleep(POLL_MS);
  }
  throw new Error(timeoutMessage);
}

// Refuses to deploy when the project no longer matches what this script
// was reviewed against (wrong repo, branch or folder).
async function checkProject(app) {
  const project = await vercel(`/v9/projects/${app.project}`);
  const link = project.link ?? {};
  if (
    project.name !== app.name ||
    project.rootDirectory !== app.rootDirectory ||
    link.type !== "github" ||
    link.org !== REPO.org ||
    link.repo !== REPO.repo ||
    link.productionBranch !== "main"
  ) {
    throw new Error(
      `Vercel project ${app.name} differs from the reviewed configuration`,
    );
  }
}

async function readDeployment(id, sha) {
  const deployment = await vercel(`/v13/deployments/${id}`);
  if (deployment.gitSource?.sha !== sha) {
    throw new Error(`Deployment ${id} is not built from ${sha}`);
  }
  if (deployment.target !== "production") {
    throw new Error(`Deployment ${id} is not a production deployment`);
  }
  if (["ERROR", "CANCELED"].includes(deployment.readyState)) {
    throw new Error(`Deployment ${id} is ${deployment.readyState}`);
  }
  return deployment;
}

async function build(sha) {
  const lines = [];
  const ids = {};
  await Promise.all(
    Object.entries(APPS).map(async ([key, app]) => {
      await checkProject(app);
      const { id } = await vercel("/v13/deployments", {
        query: "forceNew=1",
        body: {
          name: app.name,
          project: app.project,
          target: "production",
          // ref must be the branch: the projects' ignored build step only
          // builds main and staging.
          gitSource: { type: "github", ...REPO, ref: "main", sha },
          autoAssignCustomDomains: false,
        },
      });
      lines.push(`- ${app.name}: deployment ${id} created`);
      const deployment = await poll(
        () => readDeployment(id, sha),
        ({ readyState }) => readyState === "READY",
        180,
        `${app.name}: deployment ${id} is not READY after 15 minutes`,
      );
      lines.push(`- ${app.name}: READY at https://${deployment.url}`);
      ids[key] = id;
    }),
  );
  publishSummary(`Vercel build: ${sha}`, [
    ...lines,
    "",
    "Built without custom domains. Production still serves the previous deployments.",
  ]);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `backend=${ids.backend}\nfrontend=${ids.frontend}\n`,
    );
  }
}

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(20_000),
      });
      const body = await response.text();
      if (response.ok) return JSON.parse(body);
      if (attempt === 5) throw new Error(`HTTP ${response.status} ${body}`);
    } catch (error) {
      if (attempt === 5) throw new Error(`${url}: ${error.message}`);
    }
    await sleep(POLL_MS);
  }
}

// /health reads the database, so on the new deployment it proves that the
// new code works with the migrated schema.
async function smokeBackend(base) {
  const health = await getJson(`${base}/health`);
  if (health.status !== "ok" || health.database !== "up") {
    throw new Error(`${base}/health: ${JSON.stringify(health)}`);
  }
  const manifest = await getJson(`${base}/manifest.json`);
  if (manifest.id !== "com.stremlist") {
    throw new Error(`${base}/manifest.json: unexpected id ${manifest.id}`);
  }
}

async function smokeFrontend(base) {
  const response = await fetch(base, { signal: AbortSignal.timeout(20_000) });
  const body = await response.text();
  if (response.status !== 200 || !body.includes('id="root"')) {
    throw new Error(`${base}: HTTP ${response.status}, no app root`);
  }
}

async function promote(app, id) {
  await vercel(`/v10/projects/${app.project}/promote/${id}`, { body: {} });
  await poll(
    () => vercel(`/v4/aliases/${app.domain}`, { allowNotFound: true }),
    (alias) => alias.deploymentId === id,
    36,
    `${app.domain} does not serve deployment ${id} after 3 minutes`,
  );
}

function assertMainIsStill(sha) {
  execFileSync("node", [".github/scripts/release-sha.mjs", "assert", sha], {
    stdio: "inherit",
  });
}

async function publish(sha, backendId, frontendId) {
  const lines = [];
  try {
    const backend = await readDeployment(backendId, sha);
    const frontend = await readDeployment(frontendId, sha);
    await smokeBackend(`https://${backend.url}`);
    lines.push(`- Smoke test passed on https://${backend.url}`);

    assertMainIsStill(sha);
    await checkProject(APPS.backend);
    await promote(APPS.backend, backend.id);
    await smokeBackend(`https://${APPS.backend.domain}`);
    lines.push(`- ${APPS.backend.domain} serves ${backend.id}`);

    await checkProject(APPS.frontend);
    await promote(APPS.frontend, frontend.id);
    await smokeFrontend(`https://${APPS.frontend.domain}`);
    lines.push(`- ${APPS.frontend.domain} serves ${frontend.id}`);
    lines.push("", `Status: production serves ${sha}.`);
  } catch (error) {
    lines.push(
      "",
      `Status: FAILED (${error.message}). No database rollback was done: fix forward.`,
    );
    throw error;
  } finally {
    publishSummary(`Vercel publish: ${sha}`, lines);
  }
}

const [mode, sha, ...ids] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(sha ?? "")) {
  throw new Error("Usage: vercel-release.mjs <build|publish> <sha> [ids]");
}
if (mode === "build") await build(sha);
else if (mode === "publish" && ids.length === 2) await publish(sha, ...ids);
else throw new Error("Usage: vercel-release.mjs <build|publish> <sha> [ids]");
