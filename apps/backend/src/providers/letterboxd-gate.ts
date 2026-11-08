import { z } from "zod";
import { scheduleBackgroundTask } from "../lib/background";
import { supabase } from "../lib/supabase";
import type { LetterboxdRequestDetails } from "./letterboxd-request-log";
import { recordLetterboxdRequest } from "./letterboxd-request-log";
import { currentReadPriority } from "./read-priority";
import { SourceUnavailableError } from "./types";

/**
 * The shared Letterboxd gate: a token bucket in Postgres
 * (supabase/migrations/20261108120000_letterboxd_gate.sql) that every backend
 * instance asks before each Letterboxd request. The rules live in SQL.
 */
const GATE = "production";
/** Longest an interactive read waits for its slot. */
const MAX_WAIT_MS = 10_000;
/** After a longer wait, check that no slowdown or halt started meanwhile. */
const RECHECK_AFTER_MS = 1_000;

/** LETTERBOXD_MAX_RPS, the target rate in requests per second (default 10). */
function letterboxdTargetRate(): number {
  const value = Number(process.env.LETTERBOXD_MAX_RPS);
  return Number.isFinite(value) && value > 0 ? value : 10;
}

/** How a Letterboxd request ended, as the gate counts it. */
export type LetterboxdOutcome = "ok" | "rate_limited" | "blocked" | "failed";

/**
 * Letterboxd is busy: the read would wait longer than its caller allows, or a
 * slowdown after a 429 is in progress. `waitMs` estimates when to try again.
 */
export class LetterboxdBusyError extends SourceUnavailableError {
  readonly waitMs: number;

  constructor(waitMs: number) {
    super("unavailable", "Letterboxd is busy");
    this.name = "LetterboxdBusyError";
    this.waitMs = waitMs;
  }
}

const takeSchema = z.object({
  status: z.enum(["granted", "queued", "paused", "halted"]),
  wait_ms: z.number(),
  probe: z.boolean(),
});
const reportSchema = z.object({
  halted: z.boolean(),
  halt_reason: z.enum(["blocked", "rate_limited"]).nullable(),
  recovered: z.boolean(),
  slow: z.boolean(),
});
const statusSchema = z.object({
  halted: z.boolean(),
  halt_reason: z.enum(["blocked", "rate_limited"]).nullable(),
  probe_due: z.boolean(),
  paused_ms: z.number(),
  rate: z.number(),
  slow_ms: z.number(),
});
export type LetterboxdGateStatus = z.infer<typeof statusSchema>;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Letterboxd refused Stremlist: only the gate's probes are sent until it recovers. */
const halted = () =>
  new SourceUnavailableError(
    "disabled",
    "Letterboxd is temporarily unavailable",
  );
/** The gate cannot be read: fail closed. */
const unreadable = () =>
  new SourceUnavailableError(
    "unavailable",
    "Letterboxd is temporarily unavailable",
  );

/**
 * Tell Better Stack about a gate edge. Best effort: a missing URL or a failed
 * ping never affects a read. A success ping resolves the open incident.
 */
async function heartbeat(failure: string | null) {
  const url = process.env.BETTERSTACK_HEARTBEAT_URL_LETTERBOXD;
  if (!url) return;
  try {
    await fetch(
      failure ? `${url}/fail` : url,
      failure
        ? { method: "POST", body: failure, signal: AbortSignal.timeout(5000) }
        : { signal: AbortSignal.timeout(5000) },
    );
  } catch (error) {
    console.error(
      "Reporting the Letterboxd gate to Better Stack failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

export async function letterboxdGateStatus(): Promise<LetterboxdGateStatus> {
  const { data, error } = await supabase.rpc("letterboxd_gate_status", {
    p_target: letterboxdTargetRate(),
    p_gate: GATE,
  });
  if (error) throw unreadable();
  return statusSchema.parse(data);
}

/** Whether Letterboxd reads are halted. An unreadable gate counts as not halted. */
export async function isLetterboxdHalted(): Promise<boolean> {
  try {
    return (await letterboxdGateStatus()).halted;
  } catch {
    return false;
  }
}

/**
 * Refuse a read while Letterboxd is halted, even when its pages are cached, so
 * a Refresh reports the Provider as unavailable instead of a fresh sync. When
 * the gate's next probe is due, the read goes on: its first request is the
 * probe that tells whether Letterboxd accepts Stremlist again.
 */
export async function assertLetterboxdNotHalted() {
  if (await letterboxdRefusesReads()) throw halted();
}

/**
 * Whether the halt refuses a read now: halted, and the next probe is not due
 * yet. An unreadable gate refuses nothing here; the request itself fails
 * closed at the gate.
 */
export async function letterboxdRefusesReads(): Promise<boolean> {
  try {
    const status = await letterboxdGateStatus();
    return status.halted && !status.probe_due;
  } catch {
    return false;
  }
}

async function report(
  target: number,
  outcome: LetterboxdOutcome,
  retryAfterMs: number,
  probe: boolean,
) {
  const { data, error } = await supabase.rpc("letterboxd_report", {
    p_target: target,
    p_outcome: outcome,
    p_retry_after_ms: Math.min(Math.round(retryAfterMs), 2_147_483_647),
    p_probe: probe,
    p_gate: GATE,
  });
  if (error) {
    console.error("Recording a Letterboxd request failed:", error.message);
    return;
  }
  const edges = reportSchema.parse(data);
  if (edges.halted)
    await heartbeat(
      edges.halt_reason === "blocked"
        ? "Letterboxd halted: it refused a request (403 or a challenge)"
        : "Letterboxd halted: it kept answering 429 at the lowest rate",
    );
  if (edges.recovered) await heartbeat(null);
  if (edges.slow)
    await heartbeat(
      "Letterboxd has run below half of LETTERBOXD_MAX_RPS for 30 minutes after 429 responses. Lower LETTERBOXD_MAX_RPS.",
    );
}

/**
 * Send one Letterboxd request through the shared gate. The request waits for
 * its slot (interactive reads, up to 10 s) or is refused when none is free
 * now (background reads). Its outcome is recorded after it returns.
 */
export async function withLetterboxdPermit<T>(
  read: () => Promise<{
    value: T;
    result: LetterboxdOutcome;
    retryAfterMs?: number;
    /** What the request saw, for the request log. */
    details?: LetterboxdRequestDetails;
  }>,
): Promise<T> {
  const priority = currentReadPriority();
  const target = letterboxdTargetRate();
  const { data, error } = await supabase.rpc("letterboxd_take", {
    p_target: target,
    p_max_wait_ms: MAX_WAIT_MS,
    p_background: priority === "background",
    p_gate: GATE,
  });
  if (error) throw unreadable();
  const slot = takeSchema.parse(data);
  if (slot.status === "halted") throw halted();
  if (slot.status !== "granted") throw new LetterboxdBusyError(slot.wait_ms);
  if (slot.wait_ms > 0) {
    await sleep(slot.wait_ms);
    if (slot.wait_ms > RECHECK_AFTER_MS) {
      const status = await letterboxdGateStatus();
      if (status.halted) throw halted();
      if (status.paused_ms > 0) throw new LetterboxdBusyError(status.paused_ms);
    }
  }
  let result: LetterboxdOutcome = "failed";
  let retryAfterMs = 0;
  let details: LetterboxdRequestDetails | undefined;
  const sentAt = performance.now();
  try {
    const response = await read();
    result = response.result;
    retryAfterMs = response.retryAfterMs ?? 0;
    details = response.details;
    return response.value;
  } finally {
    const durationMs = performance.now() - sentAt;
    scheduleBackgroundTask(async () => {
      await report(target, result, retryAfterMs, slot.probe);
      if (details)
        await recordLetterboxdRequest(details, {
          outcome: result,
          durationMs,
          waitMs: slot.wait_ms,
          priority,
          probe: slot.probe,
        });
    });
  }
}
