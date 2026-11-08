/**
 * In-memory versions of the Letterboxd gate RPCs
 * (supabase/migrations/20261108120000_letterboxd_gate.sql). Same rules; the
 * SQL itself is tested by supabase/tests/letterboxd_gate.sql.
 */
import type { RpcArgs, RpcHandler } from "./rpc";
import type { Result, Row } from "./store";
import { db } from "./store";

interface Gate {
  id: string;
  rate: number;
  tokens: number;
  refilledAt: number;
  rateChangedAt: number;
  pausedUntil: number;
  haltedAt: number | null;
  haltReason: "blocked" | "rate_limited" | null;
  nextProbeAt: number | null;
  probeUntil: number | null;
  floorSlowdowns: number;
  floorSlowdownsSince: number | null;
  windowStartedAt: number;
  windowRequests: number;
  windowFailures: number;
  slowSince: number | null;
  slowAlerted: boolean;
}

/** A gate by ID, kept in the in-memory tables so db.reset() clears it. */
export function letterboxdGate(id = "production"): Gate | undefined {
  return db.getTable("letterboxd_gate").find((row) => row.id === id) as
    | Gate
    | undefined;
}

const MINUTE = 60_000;

function settle(g: Gate, t: number, target: number) {
  if (g.rate < target && g.haltedAt === null && t > g.rateChangedAt) {
    const steps = Math.floor((t - g.rateChangedAt) / MINUTE);
    if (steps >= 1) {
      g.rate = Math.min(target, g.rate + 0.5 * steps);
      g.rateChangedAt += steps * MINUTE;
    }
  }
  if (g.rate > target) g.rate = target;
  if (t > g.refilledAt) {
    g.tokens = Math.min(
      Math.max(1, g.rate),
      g.tokens + (g.rate * (t - g.refilledAt)) / 1000,
    );
    g.refilledAt = t;
  }
  if (g.haltedAt === null && g.rate < 0.5 * target) {
    g.slowSince ??= t;
  } else {
    g.slowSince = null;
    g.slowAlerted = false;
  }
}

function lock(id: string, target: number, t: number): Gate {
  let g = letterboxdGate(id);
  if (!g) {
    g = {
      id,
      rate: target,
      tokens: Math.max(1, target),
      refilledAt: t,
      rateChangedAt: t,
      pausedUntil: -Infinity,
      haltedAt: null,
      haltReason: null,
      nextProbeAt: null,
      probeUntil: null,
      floorSlowdowns: 0,
      floorSlowdownsSince: null,
      windowStartedAt: t,
      windowRequests: 0,
      windowFailures: 0,
      slowSince: null,
      slowAlerted: false,
    };
    db.getTable("letterboxd_gate").push(g as unknown as Row);
  }
  return g;
}

const targetOf = (args: RpcArgs) => Math.max(Number(args.p_target), 0.01);
const gateOf = (args: RpcArgs) =>
  typeof args.p_gate === "string" ? args.p_gate : "production";
const ok = (data: unknown): Result => ({ data, error: null }) as Result;

function take(args: RpcArgs): Result {
  const t = Date.now();
  const target = targetOf(args);
  const g = lock(gateOf(args), target, t);
  settle(g, t, target);
  if (g.haltedAt !== null) {
    if (
      g.nextProbeAt !== null &&
      g.nextProbeAt <= t &&
      (g.probeUntil === null || g.probeUntil <= t)
    ) {
      g.probeUntil = t + MINUTE;
      g.nextProbeAt = t + 30 * MINUTE;
      return ok({ status: "granted", wait_ms: 0, probe: true });
    }
    return ok({ status: "halted", wait_ms: 0, probe: false });
  }
  if (g.pausedUntil > t)
    return ok({
      status: "paused",
      wait_ms: Math.ceil(g.pausedUntil - t),
      probe: false,
    });
  if (g.tokens >= 1) {
    g.tokens -= 1;
    return ok({ status: "granted", wait_ms: 0, probe: false });
  }
  const waitMs = Math.ceil(((1 - g.tokens) / g.rate) * 1000);
  if (args.p_background === true || waitMs > Number(args.p_max_wait_ms))
    return ok({ status: "queued", wait_ms: waitMs, probe: false });
  g.tokens -= 1;
  return ok({ status: "granted", wait_ms: waitMs, probe: false });
}

function report(args: RpcArgs): Result {
  const t = Date.now();
  const target = targetOf(args);
  const floorRate = Math.min(0.33, target);
  const g = lock(gateOf(args), target, t);
  settle(g, t, target);
  let halted = false;
  let recovered = false;
  let slow = false;
  if (g.haltedAt !== null) {
    if (args.p_probe === true) {
      g.probeUntil = null;
      if (args.p_outcome === "ok") {
        Object.assign(g, {
          haltedAt: null,
          haltReason: null,
          nextProbeAt: null,
          rate: floorRate,
          rateChangedAt: t,
          tokens: 0,
          refilledAt: t,
          floorSlowdowns: 0,
          floorSlowdownsSince: null,
          windowStartedAt: t,
          windowRequests: 0,
          windowFailures: 0,
        });
        recovered = true;
      } else {
        g.nextProbeAt = t + 30 * MINUTE;
      }
    }
  } else {
    if (t - g.windowStartedAt >= MINUTE) {
      g.windowStartedAt = t;
      g.windowRequests = 0;
      g.windowFailures = 0;
    }
    g.windowRequests++;
    let slowDown = false;
    if (args.p_outcome === "blocked") {
      g.haltedAt = t;
      g.haltReason = "blocked";
      g.nextProbeAt = t + 30 * MINUTE;
      halted = true;
    } else if (args.p_outcome === "rate_limited") {
      slowDown = true;
    } else if (args.p_outcome === "failed") {
      g.windowFailures++;
      if (g.windowRequests >= 20 && g.windowFailures > 0.2 * g.windowRequests) {
        slowDown = true;
        g.windowStartedAt = t;
        g.windowRequests = 0;
        g.windowFailures = 0;
      }
    }
    if (slowDown) {
      if (g.rate <= floorRate + 1e-9) {
        if (
          g.floorSlowdownsSince === null ||
          t - g.floorSlowdownsSince > 15 * MINUTE
        ) {
          g.floorSlowdownsSince = t;
          g.floorSlowdowns = 1;
        } else {
          g.floorSlowdowns++;
        }
      }
      if (g.floorSlowdowns >= 3) {
        g.haltedAt = t;
        g.haltReason = "rate_limited";
        g.nextProbeAt = t + 30 * MINUTE;
        halted = true;
      } else {
        g.pausedUntil = Math.max(
          g.pausedUntil,
          t + Math.max(Number(args.p_retry_after_ms) || 0, MINUTE),
        );
        g.rate = Math.max(floorRate, g.rate / 2);
        g.rateChangedAt = g.pausedUntil;
        g.tokens = 0;
        g.refilledAt = g.pausedUntil;
      }
    }
  }
  settle(g, t, target);
  if (
    g.slowSince !== null &&
    t - g.slowSince >= 30 * MINUTE &&
    !g.slowAlerted
  ) {
    g.slowAlerted = true;
    slow = true;
  }
  return ok({ halted, halt_reason: g.haltReason, recovered, slow });
}

function status(args: RpcArgs): Result {
  const t = Date.now();
  const target = targetOf(args);
  const stored = letterboxdGate(gateOf(args));
  if (!stored)
    return ok({
      halted: false,
      halt_reason: null,
      probe_due: false,
      paused_ms: 0,
      rate: target,
      slow_ms: 0,
    });
  const g = { ...stored };
  settle(g, t, target);
  return ok({
    halted: g.haltedAt !== null,
    halt_reason: g.haltReason,
    probe_due:
      g.haltedAt !== null &&
      g.nextProbeAt !== null &&
      g.nextProbeAt <= t &&
      (g.probeUntil === null || g.probeUntil <= t),
    paused_ms: Math.max(0, Math.ceil(g.pausedUntil - t)),
    rate: g.rate,
    slow_ms: g.slowSince === null ? 0 : t - g.slowSince,
  });
}

export const letterboxdGateRpcs: Record<string, RpcHandler> = {
  letterboxd_take: take,
  letterboxd_report: report,
  letterboxd_gate_status: status,
};

/** Halt a gate as if Letterboxd had refused a request. */
export function haltLetterboxdGate(id = "production"): void {
  const g = lock(id, 10, Date.now());
  g.haltedAt = Date.now();
  g.haltReason = "blocked";
  g.nextProbeAt = Date.now() + 30 * MINUTE;
}
