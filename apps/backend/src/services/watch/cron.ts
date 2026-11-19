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

const READ_BUDGET_MS = 35_000;
const RUN_BUDGET_MS = 50_000;
const WRITE_BUDGET_MS = 40_000;

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

function message(error: unknown) {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

async function heartbeat(report: CronReport) {
  const url = process.env.BETTERSTACK_HEARTBEAT_URL_WATCH?.trim();
  if (!url) return;
  const backlog = report.simklBacklogSeconds ?? 0;
  const problems = [...report.errors];
  const { reads, writes, simkl } = report;
  if (reads && reads.failed >= 10 && reads.failed > reads.read) {
    problems.push(`${reads.failed} of ${reads.claimed} Stremio reads failed`);
  }
  const sent = (writes?.sent ?? 0) + (simkl?.sent ?? 0);
  const failed = (writes?.failed ?? 0) + (simkl?.failed ?? 0);
  if (failed >= 5 && failed > sent) {
    problems.push(`${failed} Destination writes failed, ${sent} sent`);
  }
  if (backlog > SIMKL_BACKLOG_ALERT_SECONDS) {
    problems.push(
      `The oldest Simkl write waits ${Math.round(backlog / 60)} min`,
    );
  }
  try {
    if (problems.length === 0) await fetch(url);
    else
      await fetch(`${url}/fail`, { method: "POST", body: problems.join("\n") });
  } catch {}
}

export async function runWatchCron() {
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
      const [reads, writes] = await Promise.all([
        step("reads", () => processReads(started + READ_BUDGET_MS)),
        step("writes", () => processWrites(started + WRITE_BUDGET_MS)),
      ]);
      report.reads = reads;
      report.writes = writes;

      if (
        reads &&
        reads.detected > 0 &&
        Date.now() < started + WRITE_BUDGET_MS
      ) {
        const fresh = await step("fresh writes", () =>
          processWrites(started + WRITE_BUDGET_MS),
        );
        if (fresh)
          report.writes = {
            sent: (writes?.sent ?? 0) + fresh.sent,
            failed: (writes?.failed ?? 0) + fresh.failed,
            gaveUp: (writes?.gaveUp ?? 0) + fresh.gaveUp,
            rateLimited: (writes?.rateLimited ?? false) || fresh.rateLimited,
          };
      }
      report.sweep = await step("sweep", () =>
        processSweep(started + RUN_BUDGET_MS),
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
