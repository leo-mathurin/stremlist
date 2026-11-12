/**
 * One run of the Watch tracking cron, every minute (ADR 0003). Two parts
 * run side by side, each with its own time budget, so Simkl's pacing never
 * delays the reads:
 *
 * - the due reads, then the sweep minutes, then the Trakt and MDBList
 *   writes;
 * - the Simkl writes, through the global limiter.
 *
 * The run reports to a Better Stack heartbeat, which also alerts when the
 * oldest due Simkl write waits more than 10 minutes.
 */
import type { ReadStats } from "./reads";
import { processReads } from "./reads";
import type { SweepStats } from "./sweep";
import { processSweep } from "./sweep";
import type { WriteStats } from "./writes";
import {
  processSimklWrites,
  processWrites,
  SIMKL_BACKLOG_ALERT_SECONDS,
  simklBacklogSeconds,
} from "./writes";

/** Reads stop taking new batches after this, so the run ends in time. */
const READ_BUDGET_MS = 35_000;
const RUN_BUDGET_MS = 50_000;

export interface CronReport {
  ok: boolean;
  ms: number;
  reads?: ReadStats;
  sweep?: SweepStats;
  writes?: WriteStats;
  simkl?: WriteStats;
  simklBacklogSeconds?: number;
  errors: string[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function heartbeat(report: CronReport): Promise<void> {
  const url = process.env.BETTERSTACK_HEARTBEAT_URL_WATCH?.trim();
  if (!url) return;
  const backlog = report.simklBacklogSeconds ?? 0;
  const problems = [...report.errors];
  if (backlog > SIMKL_BACKLOG_ALERT_SECONDS) {
    problems.push(
      `The oldest Simkl write waits ${Math.round(backlog / 60)} min`,
    );
  }
  try {
    if (problems.length === 0) await fetch(url);
    else
      await fetch(`${url}/fail`, { method: "POST", body: problems.join("\n") });
  } catch {
    /* Better Stack also alerts when the heartbeat stops arriving. */
  }
}

export async function runWatchCron(): Promise<CronReport> {
  const started = Date.now();
  const report: CronReport = { ok: true, ms: 0, errors: [] };
  const step = async <T>(name: string, task: () => Promise<T>) => {
    try {
      return await task();
    } catch (error) {
      report.errors.push(`${name}: ${message(error)}`);
      console.error(`Watch tracking ${name} failed:`, message(error));
      return undefined;
    }
  };
  report.simklBacklogSeconds = await step("simkl backlog", simklBacklogSeconds);
  await Promise.all([
    (async () => {
      report.reads = await step("reads", () =>
        processReads(started + READ_BUDGET_MS),
      );
      report.sweep = await step("sweep", processSweep);
      report.writes = await step("writes", () =>
        processWrites(started + RUN_BUDGET_MS),
      );
    })(),
    (async () => {
      report.simkl = await step("simkl writes", () =>
        processSimklWrites(
          started + RUN_BUDGET_MS,
          report.simklBacklogSeconds ?? 0,
        ),
      );
    })(),
  ]);
  report.ok = report.errors.length === 0;
  report.ms = Date.now() - started;
  await heartbeat(report);
  return report;
}
