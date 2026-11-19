import { describe, it, expect } from "vite-plus/test";
import { fetchWatchlist } from "../imdb-scraper.js";

const USER_IDS = [
  "ur101395618",
  "ur195879360",
  "ur101546112",
  "ur102135398",
  "ur102185135",
  "ur102200114",
  "ur102367147",
  "ur102383613",
  "ur102551738",
  "ur102823061",
  "ur102873414",
];

const PHASES = [
  { label: "warm-up", concurrency: 3, rounds: 1 },
  { label: "sustained", concurrency: 10, rounds: 10 },
  { label: "high load", concurrency: 15, rounds: 5 },
  { label: "spike", concurrency: 25, rounds: 3 },
  { label: "cool-down", concurrency: 5, rounds: 3 },
];

const MAX_ERROR_RATE = 0.05;
const MAX_P95_MS = 8_000;

interface RequestResult {
  userId: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  itemCount?: number;
}

function pickId(index: number) {
  return USER_IDS[index % USER_IDS.length];
}

async function runRequest(userId: string) {
  const start = performance.now();
  try {
    const data = await fetchWatchlist(userId);
    return {
      userId,
      durationMs: performance.now() - start,
      ok: true,
      itemCount: data.metas.length,
    };
  } catch (err) {
    return {
      userId,
      durationMs: performance.now() - start,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runBatch(userIds: string[]) {
  return Promise.all(userIds.map(runRequest));
}

function percentile(sorted: number[], p: number) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function printMetrics(label: string, results: RequestResult[]) {
  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const errors = results.filter((r) => !r.ok);
  const errorRate = errors.length / results.length;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Phase: ${label}`);
  console.log("─".repeat(60));
  console.log(`Requests : ${results.length}`);
  console.log(
    `Success  : ${results.length - errors.length} / ${results.length} (${((1 - errorRate) * 100).toFixed(1)}%)`,
  );
  console.log(`Latency (ms):`);
  console.log(`  min  : ${durations[0].toFixed(0)}`);
  console.log(`  p50  : ${percentile(durations, 50).toFixed(0)}`);
  console.log(`  p95  : ${percentile(durations, 95).toFixed(0)}`);
  console.log(`  p99  : ${percentile(durations, 99).toFixed(0)}`);
  console.log(`  max  : ${durations[durations.length - 1].toFixed(0)}`);

  if (errors.length > 0) {
    const grouped: Record<string, number> = {};
    for (const e of errors) {
      const key = e.error ?? "unknown";
      grouped[key] = (grouped[key] ?? 0) + 1;
    }
    console.log(`Errors:`);
    for (const [msg, count] of Object.entries(grouped)) {
      console.log(`  [${count}x] ${msg.substring(0, 80)}`);
    }
  }
}

describe("stress: IMDb GraphQL scraper under load", () => {
  let globalResults: RequestResult[] = [];
  let requestIndex = 0;

  for (const phase of PHASES) {
    it(`${phase.label} — ${phase.concurrency} concurrent × ${phase.rounds} round(s)`, async () => {
      const phaseResults: RequestResult[] = [];

      for (let r = 0; r < phase.rounds; r++) {
        const ids = Array.from({ length: phase.concurrency }, () =>
          pickId(requestIndex++),
        );
        const batchResults = await runBatch(ids);
        phaseResults.push(...batchResults);
      }

      printMetrics(phase.label, phaseResults);
      globalResults = globalResults.concat(phaseResults);

      const errorRate =
        phaseResults.filter((r) => !r.ok).length / phaseResults.length;
      const durations = phaseResults
        .map((r) => r.durationMs)
        .sort((a, b) => a - b);
      const p95 = percentile(durations, 95);

      expect(
        errorRate,
        `error rate exceeded ${MAX_ERROR_RATE * 100}%`,
      ).toBeLessThanOrEqual(MAX_ERROR_RATE);
      expect(p95, `p95 latency exceeded ${MAX_P95_MS}ms`).toBeLessThan(
        MAX_P95_MS,
      );
    });
  }

  it("overall summary", () => {
    if (globalResults.length === 0) return;

    printMetrics("overall", globalResults);

    const totalRequests = globalResults.length;
    const totalErrors = globalResults.filter((r) => !r.ok).length;
    const errorRate = totalErrors / totalRequests;
    const durations = globalResults
      .map((r) => r.durationMs)
      .sort((a, b) => a - b);

    console.log(
      `\nThresholds: error rate ≤ ${MAX_ERROR_RATE * 100}%, p95 < ${MAX_P95_MS}ms`,
    );

    expect(errorRate).toBeLessThanOrEqual(MAX_ERROR_RATE);
    expect(percentile(durations, 95)).toBeLessThan(MAX_P95_MS);
  });
});
