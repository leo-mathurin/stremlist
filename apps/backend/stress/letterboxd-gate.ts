import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    target: { type: "string", default: "pg" },
    users: { type: "string", default: "5000" },
    "arrival-minutes": { type: "string", default: "10" },
    "drain-minutes": { type: "string", default: "20" },
    rate: { type: "string", default: "10" },
    schema: { type: "string", default: "public" },
    out: { type: "string" },
  },
});
const USERS = Number(values.users);
const ARRIVAL_MS = Number(values["arrival-minutes"]) * 60_000;
const DEADLINE_MS = ARRIVAL_MS + Number(values["drain-minutes"]) * 60_000;
const RATE = Number(values.rate);
const PAGE_MS = 200;
const RECHECK_AFTER_MS = 1_000;
const QUEUE_STATE_MS = 3_000;
const STREMIO_CARD_MS = 10_000;
const GATE = `stress-${Date.now()}`;
const FILMS_PER_PAGE = 28;

type Json = Record<string, unknown>;
type GateCall = "take_turn" | "report" | "gate_status";
interface Gate {
  call(name: GateCall, args: Json): Promise<Json>;
  close(): Promise<void>;
}

function pgGate() {
  const url = process.env.STRESS_GATE_DATABASE_URL;
  if (!url) throw new Error("Set STRESS_GATE_DATABASE_URL");
  const sql = new Bun.SQL(url, { max: 20 });
  const schema = values.schema;
  return {
    async call(name, args) {
      const fn = `${schema}.letterboxd_${name}`;
      const rows: { result: Json; now_ms?: number | string }[] =
        name === "take_turn"
          ? await sql.unsafe(
              `SELECT ${fn}($1, $2, $3, $4) AS result, extract(epoch FROM clock_timestamp()) * 1000 AS now_ms`,
              [args.p_target, args.p_priority, args.p_ticket, GATE],
            )
          : name === "report"
            ? await sql.unsafe(`SELECT ${fn}($1, $2, $3, $4, $5) AS result`, [
                args.p_target,
                args.p_outcome,
                args.p_retry_after_ms,
                args.p_probe,
                GATE,
              ])
            : await sql.unsafe(`SELECT ${fn}($1, $2) AS result`, [
                args.p_target,
                GATE,
              ]);
      const [row] = rows;
      return row.now_ms === undefined
        ? row.result
        : { ...row.result, db_now_ms: Number(row.now_ms) };
    },
    async close() {
      await sql.unsafe(`DELETE FROM ${schema}.letterboxd_gate WHERE id = $1`, [
        GATE,
      ]);
      await sql.unsafe(
        `DELETE FROM ${schema}.letterboxd_waiters WHERE gate = $1`,
        [GATE],
      );
      await sql.close();
    },
  };
}

function restGate() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  const client = createClient(url, key, { auth: { persistSession: false } });
  const prefix =
    values.schema === "public" ? "letterboxd_" : `${values.schema}_letterboxd_`;
  return {
    async call(name, args) {
      const { data, error } = (await client.rpc(`${prefix}${name}`, {
        ...args,
        p_gate: GATE,
      })) as { data: unknown; error: { message: string } | null };
      if (error) throw new Error(`${name}: ${error.message}`);
      return z.record(z.string(), z.unknown()).parse(data);
    },
    async close() {
      if (values.schema !== "public") return;
      const { error } = (await client
        .from("letterboxd_gate")
        .delete()
        .eq("id", GATE)) as { error: { message: string } | null };
      if (error) throw new Error(`Deleting ${GATE}: ${error.message}`);
    },
  };
}

const gate = values.target === "rest" ? restGate() : pgGate();
const latencies: Record<GateCall, number[]> = {
  take_turn: [],
  report: [],
  gate_status: [],
};
const errors: string[] = [];
async function call(name: GateCall, args: Json) {
  const started = performance.now();
  try {
    return await gate.call(name, args);
  } finally {
    latencies[name].push(performance.now() - started);
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function pagesFor(index: number) {
  const bucket = (index * 7919) % 100;
  const films =
    bucket < 5
      ? 0
      : bucket < 25
        ? 4
        : bucket < 75
          ? 50
          : bucket < 95
            ? 250
            : bucket < 99
              ? 1000
              : 2800;
  return Math.max(1, Math.min(100, Math.ceil(films / FILMS_PER_PAGE)));
}

interface UserResult {
  pages: number;
  firstPageMs: number | null;
  totalMs: number | null;
  queueState: boolean;
  longestEstimateMs: number;
  firstEstimateErrorMs: number | null;
}
const sends: number[] = [];
const slots: number[] = [];
const reports: Promise<unknown>[] = [];
const start = performance.now();
const elapsed = () => performance.now() - start;

async function user(index: number) {
  await sleep((index / USERS) * ARRIVAL_MS);
  const pages = pagesFor(index);
  const began = elapsed();
  const result: UserResult = {
    pages,
    firstPageMs: null,
    totalMs: null,
    queueState: false,
    longestEstimateMs: 0,
    firstEstimateErrorMs: null,
  };
  let ticket: string | null = null;
  let firstEstimate: number | null = null;
  for (let page = 0; page < pages; page++) {
    for (;;) {
      if (elapsed() > DEADLINE_MS) return result;
      let slot: Json;
      try {
        slot = await call("take_turn", {
          p_target: RATE,
          p_priority: page === 0 ? "first" : "later",
          p_ticket: ticket,
        });
      } catch (error) {
        errors.push(String(error));
        await sleep(1000);
        continue;
      }
      ticket = typeof slot.ticket === "string" ? slot.ticket : null;
      const wait = Number(slot.wait_ms);
      result.longestEstimateMs = Math.max(result.longestEstimateMs, wait);
      if (page === 0) {
        firstEstimate ??= elapsed() - began + wait + PAGE_MS;
        if (wait >= QUEUE_STATE_MS) result.queueState = true;
      }
      if (slot.status !== "granted") {
        await sleep(Number(slot.retry_ms ?? wait));
        continue;
      }
      if (wait > 0) {
        await sleep(wait);
        if (wait > RECHECK_AFTER_MS) {
          const status = await call("gate_status", { p_target: RATE });
          if (status.halted || Number(status.paused_ms) > 0) continue;
        }
      }
      sends.push(elapsed());
      if (slot.db_now_ms !== undefined)
        slots.push(Number(slot.db_now_ms) + wait);
      await sleep(PAGE_MS);
      reports.push(
        call("report", {
          p_target: RATE,
          p_outcome: "ok",
          p_retry_after_ms: 0,
          p_probe: false,
        }).catch((error: unknown) => errors.push(String(error))),
      );
      break;
    }
    if (result.firstPageMs === null) {
      result.firstPageMs = elapsed() - began;
      result.firstEstimateErrorMs =
        firstEstimate === null ? null : result.firstPageMs - firstEstimate;
    }
  }
  result.totalMs = elapsed() - began;
  return result;
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
function summary(values: number[]) {
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: percentile(values, 1),
  };
}
function maxInWindow(times: number[], windowMs: number) {
  const sorted = [...times].sort((a, b) => a - b);
  let maximum = 0;
  let from = 0;
  for (let to = 0; to < sorted.length; to++) {
    while (sorted[to] - sorted[from] >= windowMs) from++;
    maximum = Math.max(maximum, to - from + 1);
  }
  return maximum;
}

const progress = setInterval(() => {
  console.log(
    `${Math.round(elapsed() / 1000)} s: ${sends.length} pages sent, ${errors.length} errors`,
  );
}, 30_000);
const users = await Promise.all(
  Array.from({ length: USERS }, (_, index) => user(index)),
);
await Promise.all(reports);
clearInterval(progress);
await gate.close();

const finished = users.filter((item) => item.totalMs !== null);
const burst = Math.max(1, RATE);
const report = {
  target: values.target,
  users: USERS,
  arrivalMinutes: ARRIVAL_MS / 60_000,
  rate: RATE,
  pagesDemanded: users.reduce((sum, item) => sum + item.pages, 0),
  pagesSent: sends.length,
  admission: {
    timeline: slots.length > 0 ? "gate (database clock)" : "client",
    max1s: maxInWindow(slots.length > 0 ? slots : sends, 1000),
    allowed1s: RATE + burst,
    max10s: maxInWindow(slots.length > 0 ? slots : sends, 10_000),
    clientMax10s: maxInWindow(sends, 10_000),
    allowed10s: RATE * 10 + burst,
  },
  rpcMs: {
    take_turn: summary(latencies.take_turn),
    report: summary(latencies.report),
    gate_status: summary(latencies.gate_status),
  },
  usersFinished: finished.length,
  usersUnfinished: USERS - finished.length,
  firstPageMs: summary(
    users.flatMap((item) =>
      item.firstPageMs === null ? [] : [item.firstPageMs],
    ),
  ),
  totalMs: summary(finished.map((item) => item.totalMs ?? 0)),
  firstEstimateErrorMs: summary(
    users.flatMap((item) =>
      item.firstEstimateErrorMs === null ? [] : [item.firstEstimateErrorMs],
    ),
  ),
  queueStateShare: users.filter((item) => item.queueState).length / USERS,
  stremioCardShare:
    users.filter(
      (item) => item.firstPageMs === null || item.firstPageMs > STREMIO_CARD_MS,
    ).length / USERS,
  errors: errors.length,
  firstErrors: errors.slice(0, 5),
};
const failures = [
  report.admission.max1s > report.admission.allowed1s &&
    `admitted ${report.admission.max1s} in 1 s`,
  report.admission.max10s > report.admission.allowed10s &&
    `admitted ${report.admission.max10s} in 10 s`,
  report.errors > 0 && `${report.errors} gate errors`,
].filter(Boolean);
console.log(JSON.stringify(report, null, 2));
if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2));
if (failures.length > 0) throw new Error(`FAILED: ${failures.join(", ")}`);
