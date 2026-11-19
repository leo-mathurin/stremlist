import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  backendDir,
  createBucket,
  findStack,
  psql,
  removeBucket,
  STRESS_BUCKET,
  StackError,
} from "./stack";
import type { Stack } from "./stack";

const HELP = `Usage: bun run stress:prewarm [options]

Options:
  --lists <list>        Comma separated List counts (default 10,20,30,50)
  --runs <n>            Runs of each count, each with other Source lists (default 3)
  --size <n>            Titles of every List; 0 uses the size model of mock-fetch (default 0)
  --sources <n>         Source lists of every List, merged into one Catalog (default 1)
  --base-latency <ms>   Fake IMDb latency per call (default 300)
  --item-latency <ms>   Extra fake IMDb latency per title (default 0.3)
  -h, --help            Show this help

Start the local stack first: bun run dev:local`;

const resultSchema = z.object({
  lists: z.number(),
  prewarmed: z.number(),
  ms: z.number(),
  peakRssMB: z.number(),
  imdbCalls: z.number(),
  maxInflight: z.number(),
});
type Result = z.infer<typeof resultSchema>;

async function child(
  stack: Stack,
  lists: number,
  sources: number,
  seed: string,
) {
  const { stats } = await import("./mock-fetch");
  const { getAccountLists } = await import("../src/services/accounts");
  const { prewarmLists } = await import("../src/services/list-prewarm");

  const accountId = await psql(
    stack,
    `with a as (insert into public.accounts (is_active) values (true) returning id)
     , l as (
       insert into public.lists (account_id, provider, source_ref, catalog_title, sort_option, position, merged_sources)
       select a.id, 'imdb', 'ls8' || :'seed' || lpad(g::text, 4, '0') || '0', 'bench ' || g, 'added_at-desc', g,
         (select coalesce(jsonb_agg(jsonb_build_object('provider', 'imdb', 'source_ref',
           'ls8' || :'seed' || lpad(g::text, 4, '0') || s)), '[]'::jsonb)
          from generate_series(1, :sources - 1) s)
       from a, generate_series(0, :n - 1) g
       returning account_id
     )
     select distinct account_id from l;`,
    { n: lists, sources, seed },
  );
  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 50);
  try {
    const configLists = await getAccountLists(accountId);
    let prewarmed = 0;
    const log = console.log;
    console.log = (...args: unknown[]) => {
      const match = /^Prewarmed (\d+)\//.exec(String(args[0]));
      if (match) prewarmed = Number(match[1]);
    };
    const startedAt = performance.now();
    await prewarmLists(accountId, configLists, false, null);
    const ms = Math.round(performance.now() - startedAt);
    console.log = log;
    const result: Result = {
      lists,
      prewarmed,
      ms,
      peakRssMB: Math.round(peakRss / 1e6),
      imdbCalls: stats.imdbPages,
      maxInflight: stats.maxInflight,
    };
    process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
  } finally {
    clearInterval(sampler);
    await psql(stack, `delete from public.accounts where id = :'id';`, {
      id: accountId,
    });
  }
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

async function main() {
  const { values } = parseArgs({
    options: {
      child: { type: "string" },
      seed: { type: "string" },
      sources: { type: "string" },
      lists: { type: "string" },
      runs: { type: "string" },
      size: { type: "string" },
      "base-latency": { type: "string" },
      "item-latency": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const stack = await findStack();
  if (values.child) {
    await child(
      stack,
      Number(values.child),
      Number(values.sources ?? 1),
      values.seed ?? "0",
    );
    return;
  }

  const counts = (values.lists ?? "10,20,30,50").split(",").map(Number);
  const runs = Number(values.runs ?? 3);
  await createBucket(stack);
  const script = fileURLToPath(import.meta.url);
  const rows: string[] = [];
  try {
    for (const lists of counts) {
      const results: Result[] = [];
      for (let run = 0; run < runs; run++) {
        const output = spawnSync(
          "bun",
          [
            "--no-env-file",
            script,
            "--child",
            String(lists),
            "--seed",
            `${String(lists)}${String(run)}`,
            "--sources",
            values.sources ?? "1",
          ],
          {
            cwd: backendDir,
            encoding: "utf8",
            maxBuffer: 64 << 20,
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              TMPDIR: process.env.TMPDIR,
              SUPABASE_URL: stack.supabaseUrl,
              SUPABASE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
              R2_ENDPOINT: stack.r2Endpoint,
              R2_ACCESS_KEY_ID: stack.r2AccessKeyId,
              R2_SECRET_ACCESS_KEY: stack.r2SecretAccessKey,
              R2_BUCKET: STRESS_BUCKET,
              CONNECTION_ENCRYPTION_KEY: Buffer.alloc(32, "k").toString(
                "base64",
              ),
              FRONTEND_URL: "http://localhost:5173",
              RESEND_API_KEY: "re_dummy_stress",
              MOCK_BASE_MS: values["base-latency"] ?? "300",
              MOCK_PER_ITEM_MS: values["item-latency"] ?? "0.3",
              MOCK_LIST_SIZE: values.size ?? "0",
            },
          },
        );
        const line = output.stdout
          .split("\n")
          .find((text) => text.startsWith("RESULT "));
        if (!line) {
          process.stderr.write(output.stdout.slice(-4000));
          process.stderr.write(output.stderr.slice(-4000));
          throw new Error(`The run with ${String(lists)} Lists failed.`);
        }
        const result = resultSchema.parse(JSON.parse(line.slice(7)));
        console.log(JSON.stringify(result));
        results.push(result);
      }
      const ms = results.map((r) => r.ms);
      rows.push(
        `| ${String(lists)} | ${String(median(ms))} | ${String(Math.max(...ms))} | ${String(Math.min(...results.map((r) => r.prewarmed)))} | ${String(Math.max(...results.map((r) => r.peakRssMB)))} | ${String(Math.max(...results.map((r) => r.maxInflight)))} |`,
      );
    }
  } finally {
    await removeBucket(stack);
  }
  console.log(
    [
      "",
      "| Lists | Median ms | Max ms | Fewest prewarmed | Peak RSS MB | Max IMDb calls in flight |",
      "| ----- | --------- | ------ | ---------------- | ----------- | ------------------------ |",
      ...rows,
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof StackError ? error.message : error);
  process.exitCode = 1;
});
