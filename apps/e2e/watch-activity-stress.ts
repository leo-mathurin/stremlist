import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Database } from "@stremlist/shared/database";
import { z } from "zod";
import {
  CONNECTION_ENCRYPTION_KEY,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_ENDPOINT,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} from "./env.js";
import {
  startFixtureBackend,
  type FixtureBackend,
} from "./helpers/fixture-backend.js";

if (
  SUPABASE_URL !== "http://127.0.0.1:54321" ||
  R2_ENDPOINT !== "http://127.0.0.1:7431"
)
  throw new Error("Stress testing requires the reserved local stack");
const users = z.coerce
  .number()
  .int()
  .min(1000)
  .max(12000)
  .parse(process.argv[2] ?? "6000");
const output = resolve(
  process.argv[3] ?? `test-results/watch-activity-stress-${Date.now()}.json`,
);
const db = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});
const bucket = `stremlist-activity-stress-${Date.now()}`;
const dir = mkdtempSync(join(tmpdir(), "stremlist-activity-stress-"));
const stateFile = join(dir, "state.json");
const receiptFile = join(dir, "receipts.jsonl");
const providers = ["trakt", "mdblist", "simkl"] as const;
const accounts = Array.from({ length: users }, (_, i) => ({
  id: `sl_${randomBytes(16).toString("hex").slice(0, 22)}`,
  index: i,
  provider: providers[i % 3],
  imdb: `tt${10000000 + i}`,
}));
const phases: {
  name: string;
  requests: number;
  ms: number;
  p50: number;
  p95: number;
  max: number;
}[] = [];
const snapshots: {
  name: string;
  reads: number;
  writes: number;
  receipts: number;
  tracking: number;
}[] = [];
let backend: FixtureBackend | undefined;
let ownedBucket = false;
let ownedDatabase = false;
let eventsStartedAt = 0;
let passed = false;
let delivery: {
  sent: number;
  pending: number;
  simklSent: number;
  minSimklIntervalMs: number;
} | null = null;
function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function seal(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(CONNECTION_ENCRYPTION_KEY, "base64"),
    iv,
  );
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")}`;
}
async function parallel<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  concurrency = 64,
) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) break;
        await fn(items[i]);
      }
    }),
  );
}
async function chunks<T>(
  items: T[],
  fn: (chunk: T[]) => PromiseLike<{ error: { message: string } | null }>,
) {
  for (let i = 0; i < items.length; i += 250) {
    const result = await fn(items.slice(i, i + 250));
    if (result.error) throw new Error(result.error.message);
  }
}
async function count(
  table:
    | "watch_reads"
    | "watch_writes"
    | "watch_library_receipts"
    | "watch_tracking",
  kind?: string,
) {
  let query = db
    .from(table)
    .select("account_id", { count: "exact", head: true });
  if (kind) {
    const result = await db
      .from("watch_writes")
      .select("account_id", { count: "exact", head: true })
      .eq("kind", kind);
    if (result.error) throw result.error;
    return result.count ?? 0;
  }
  const result = await query;
  if (result.error) throw result.error;
  return result.count ?? 0;
}
async function snapshot(name: string) {
  const [reads, writes, receipts, tracking] = await Promise.all([
    count("watch_reads"),
    count("watch_writes"),
    count("watch_library_receipts"),
    count("watch_tracking"),
  ]);
  const row = { name, reads, writes, receipts, tracking };
  snapshots.push(row);
  console.log(row);
  return row;
}
async function phase(
  name: string,
  work: (
    request: (path: string, init?: RequestInit) => Promise<void>,
  ) => Promise<void>,
) {
  check(backend !== undefined, "Backend not ready");
  const url = backend.url;
  const latencies: number[] = [];
  const started = performance.now();
  await work(async (path, init) => {
    const begin = performance.now();
    const response = await fetch(url + path, init);
    await response.arrayBuffer();
    latencies.push(performance.now() - begin);
    check(response.ok, `${name} ${path}: HTTP ${response.status}`);
  });
  latencies.sort((a, b) => a - b);
  const metric = {
    name,
    requests: latencies.length,
    ms: performance.now() - started,
    p50: latencies[Math.floor(latencies.length * 0.5)] ?? 0,
    p95: latencies[Math.floor(latencies.length * 0.95)] ?? 0,
    max: latencies.at(-1) ?? 0,
  };
  phases.push(metric);
  console.log(metric);
}
const receipt = z.object({
  at: z.number(),
  host: z.string(),
  token: z.string(),
  kind: z.enum(["watched", "watchlist"]),
  body: z.unknown(),
  accepted: z.boolean(),
});
const receipts = () =>
  readFileSync(receiptFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => receipt.parse(JSON.parse(line)));
function configure(watched: string[], watchlist: string[]) {
  return {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      destinations: watched,
      watchlistDestinations: watchlist,
      consent: false,
    }),
  };
}
const cronSchema = z
  .object({ ok: z.boolean(), errors: z.array(z.string()) })
  .passthrough();
async function cron() {
  check(backend !== undefined, "Backend not ready");
  const response = await fetch(backend.url + "/watch/cron", {
    headers: { Authorization: "Bearer stress-cron" },
  });
  const report = cronSchema.parse(await response.json());
  check(response.ok && report.ok, JSON.stringify(report));
  console.log({ cron: report });
}
try {
  const initial = await db
    .from("accounts")
    .select("id", { count: "exact", head: true });
  check(
    !initial.error && initial.count === 0,
    "Stress testing refuses a nonempty database",
  );
  ownedDatabase = true;
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  ownedBucket = true;
  writeFileSync(stateFile, JSON.stringify({ watched: false, outage: null }));
  writeFileSync(receiptFile, "");
  const now = new Date().toISOString();
  await chunks(accounts, (rows) =>
    db.from("accounts").insert(rows.map((a) => ({ id: a.id }))),
  );
  const links = accounts.map((a) => ({
    account_id: a.id,
    auth_key: seal(`stress-${a.index}`),
    email: `fake-${a.index}@example.test`,
  }));
  await chunks(links, (rows) => db.from("stremio_connections").insert(rows));
  await chunks(accounts, (rows) =>
    db.from("connections").insert(
      rows.map((a) => ({
        account_id: a.id,
        provider: a.provider,
        provider_username: `fake-${a.index}`,
        redirect_uri: "http://127.0.0.1/callback",
        access_token: seal(`stress-${a.index}`),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      })),
    ),
  );
  await chunks(accounts, (rows) =>
    db.from("watch_tracking").insert(
      rows.map((a) => ({
        account_id: a.id,
        baseline_at: now,
        consented_at: now,
        sweep_slot: a.index % 360,
      })),
    ),
  );
  await chunks(accounts, (rows) =>
    db.from("watch_destinations").insert(
      rows.map((a) => ({
        account_id: a.id,
        provider: a.provider,
        watched_enabled: true,
        watchlist_enabled: true,
      })),
    ),
  );
  await parallel(
    links,
    async (a) => {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `watch/${a.account_id}/state.json`,
          ContentType: "application/json",
          Body: JSON.stringify({
            link: createHash("sha256")
              .update(a.auth_key)
              .digest("hex")
              .slice(0, 16),
            checkedAt: Date.now(),
            savedAt: Date.now(),
            movies: ["tt0068646"],
            series: {},
          }),
        }),
      );
    },
    32,
  );
  backend = await startFixtureBackend("watch-stress.fixture.ts", {
    CRON_SECRET: "stress-cron",
    R2_BUCKET: bucket,
    E2E_WATCH_STRESS_STATE: stateFile,
    E2E_WATCH_STRESS_RECEIPTS: receiptFile,
  });
  eventsStartedAt = Date.now();
  await phase(
    "duplicate library additions and recovered player cycles",
    (request) =>
      parallel(accounts, async (a) => {
        const base = `/${a.id}`;
        await Promise.all([
          request(`${base}/library/movie/${a.imdb}/action=libraryAdd.json`),
          request(`${base}/library/movie/${a.imdb}/action=libraryAdd.json`),
        ]);
        for (const action of ["start", "pause", "stop"])
          await request(
            `${base}/player/movie/${a.imdb}/action=${action}&currentTime=95000&duration=100000.json`,
          );
      }),
  );
  const burst = await snapshot("after burst");
  check(
    burst.reads === users && burst.writes === users && burst.receipts === users,
    "Duplicate events changed durable counts",
  );
  check(
    (await count("watch_writes", "watched")) === 0,
    "Progress created a watched mark",
  );
  writeFileSync(stateFile, JSON.stringify({ watched: true, outage: null }));

  for (let round = 0; round < 12; round++) {
    await Promise.all([cron(), cron()]);
    const state = await snapshot(`cron ${round + 1}`);
    const pending = await db
      .from("watch_writes")
      .select("id", { count: "exact", head: true })
      .neq("provider", "simkl");
    if (pending.error) throw pending.error;
    if (state.reads === 0 && pending.count === 0) break;
  }
  const drained = await snapshot("healthy destinations drained");
  check(drained.reads === 0, "Recovered reads did not drain within budget");
  const successes = receipts().filter((r) => r.accepted);
  const owners = new Map(accounts.map((a) => [`stress-${a.index}`, a]));
  const hosts = {
    trakt: "api.trakt.tv",
    mdblist: "api.mdblist.com",
    simkl: "api.simkl.com",
  };
  check(
    successes.every((r) => {
      const owner = owners.get(r.token);
      return (
        owner !== undefined &&
        r.host === hosts[owner.provider] &&
        JSON.stringify(r.body).includes(owner.imdb)
      );
    }),
    "A destination received another account's title",
  );
  const keys = successes.map((r) => `${r.host}/${r.token}/${r.kind}`);
  check(new Set(keys).size === keys.length, "Duplicate outbound write");
  check(
    successes.length + drained.writes === users * 2,
    "Sent plus pending writes do not conserve accepted events",
  );
  const healthy = accounts.filter((a) => a.provider !== "simkl");
  check(
    successes.filter((r) => r.host !== "api.simkl.com").length ===
      healthy.length * 2,
    "Healthy destinations did not all receive both updates",
  );
  const simkl = successes
    .filter((r) => r.host === "api.simkl.com")
    .sort((a, b) => a.at - b.at);
  check(
    simkl.length > 0 &&
      simkl.every(
        (r, i) =>
          i === 0 ||
          r.at - simkl[i - 1].at >=
            (r.at - eventsStartedAt >= 600000 ? 250 : 850),
      ),
    "Simkl did not retain its global pacing",
  );
  check(
    !successes.some((r) => JSON.stringify(r.body).includes("tt0068646")),
    "An old watched title was imported",
  );
  delivery = {
    sent: successes.length,
    pending: drained.writes,
    simklSent: simkl.length,
    minSimklIntervalMs: Math.min(
      ...simkl.slice(1).map((r, i) => r.at - simkl[i].at),
    ),
  };
  const retryUsers = accounts
    .filter((a) => a.provider === "mdblist")
    .slice(0, 30);
  writeFileSync(
    stateFile,
    JSON.stringify({ watched: true, outage: "api.mdblist.com" }),
  );
  await phase("provider outage additions", (request) =>
    parallel(retryUsers, async (a) => {
      await request(`/${a.id}/library/movie/tt55555555/action=libraryAdd.json`);
    }),
  );
  await cron();
  check(
    receipts().filter((r) => !r.accepted && r.host === "api.mdblist.com")
      .length >= retryUsers.length,
    "Outage did not exercise real failed adapter writes",
  );
  const waiting = await db
    .from("watch_writes")
    .select("id", { count: "exact", head: true })
    .eq("provider", "mdblist")
    .eq("imdb_id", "tt55555555");
  check(
    !waiting.error && waiting.count === retryUsers.length,
    "Outage lost pending writes",
  );
  writeFileSync(stateFile, JSON.stringify({ watched: true, outage: null }));
  await phase("retry after provider recovery", (request) =>
    parallel(retryUsers, async (a) => {
      await request(`/${a.id}/watch-tracking/retry`, { method: "POST" });
    }),
  );
  await cron();
  const recovered = receipts().filter(
    (r) =>
      r.accepted &&
      r.host === "api.mdblist.com" &&
      JSON.stringify(r.body).includes("tt55555555"),
  );
  check(
    recovered.length === retryUsers.length,
    "Recovery did not send each waiting title exactly once",
  );
  await phase("watched opt-out keeps watchlist enabled", (request) =>
    parallel(accounts, async (a) => {
      await request(`/${a.id}/watch-tracking`, configure([], [a.provider]));
    }),
  );
  await phase("stop sharing cancels pending work", (request) =>
    parallel(accounts, async (a) => {
      await request(`/${a.id}/watch-tracking`, configure([], []));
    }),
  );
  const stopped = await snapshot("stopped");
  check(
    stopped.tracking === 0 &&
      stopped.reads === 0 &&
      stopped.writes === 0 &&
      stopped.receipts === 0,
    "Stop sharing left durable work",
  );
  await phase("late events after stop", (request) =>
    parallel(accounts, async (a) => {
      await request(`/${a.id}/library/movie/${a.imdb}/action=libraryAdd.json`);
      await request(`/${a.id}/player/movie/${a.imdb}/action=stop.json`);
    }),
  );
  const late = await snapshot("late events ignored");
  check(
    late.writes === 0 && late.reads === 0 && late.receipts === 0,
    "Late events restarted stopped sharing",
  );
  passed = true;
} finally {
  await backend?.stop();
  if (ownedDatabase)
    await chunks(accounts, (rows) =>
      db
        .from("accounts")
        .delete()
        .in(
          "id",
          rows.map((a) => a.id),
        ),
    );
  if (ownedBucket) {
    for (;;) {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
      const keys = (page.Contents ?? []).flatMap((o) =>
        o.Key ? [{ Key: o.Key }] : [],
      );
      if (!keys.length) break;
      await s3.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }),
      );
    }
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(resolve(output, ".."), { recursive: true });
  const records = {
    passed,
    users,
    userWorkers: 64,
    phases,
    snapshots,
    delivery,
    limits:
      "Local single backend, real Postgres/S3, intercepted provider transports. Simkl backlog is conserved then canceled by opt-out; it is not claimed to have fully drained.",
  };
  writeFileSync(output, JSON.stringify(records, null, 2) + "\n");
  console.log({ report: output, passed });
}
