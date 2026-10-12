// Read k6 JSON summaries and server stats, print the report table and
// evaluate the pass/fail checks.
import { readFileSync } from "node:fs";
import type { BucketUsage } from "./stack";

const ROUTES = [
  "manifest",
  "catalog",
  "new_titles",
  "meta",
  "stream",
  "trakt_catalog",
] as const;
type Route = (typeof ROUTES)[number];

interface K6Metric {
  values: Record<string, number | undefined>;
}
interface K6Summary {
  metrics: Record<string, K6Metric | undefined>;
  state?: { testRunDurationMs?: number };
}

interface RouteResult {
  requests: number;
  ok: number;
  errors5xx: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface ServerStats {
  hosts: Record<string, number>;
  imdbPages: number;
  imdbItems: number;
  maxInflight: number;
  requests: number;
  rssMB: number;
  peakRssMB: number;
}

export interface Peaks {
  dbConnections: number;
  dbActive: number;
  cpu: Record<string, number>;
}

export interface ScenarioResult {
  name: string;
  title: string;
  durationS: number;
  routes: Partial<Record<Route, RouteResult>>;
  unavailableCards: number;
  server: ServerStats | null;
  peaks: Peaks;
  /** Accounts of the Trakt outage scenario. */
  traktAccounts?: number;
}

export interface Check {
  label: string;
  pass: boolean;
}

export function readSummary(path: string): {
  durationS: number;
  routes: ScenarioResult["routes"];
  unavailableCards: number;
} {
  const summary = JSON.parse(readFileSync(path, "utf8")) as K6Summary;
  const value = (metric: string, key: string) =>
    summary.metrics[metric]?.values[key] ?? 0;
  const routes: ScenarioResult["routes"] = {};
  for (const route of ROUTES) {
    const ok = summary.metrics[`ok_${route}`];
    if (!ok) continue;
    const passes = ok.values.passes ?? 0;
    const requests = passes + (ok.values.fails ?? 0);
    if (requests === 0) continue;
    routes[route] = {
      requests,
      ok: passes,
      errors5xx: value(`e5xx_${route}`, "count"),
      p50: value(`t_${route}`, "med"),
      p95: value(`t_${route}`, "p(95)"),
      p99: value(`t_${route}`, "p(99)"),
      max: value(`t_${route}`, "max"),
    };
  }
  return {
    durationS: (summary.state?.testRunDurationMs ?? 0) / 1000,
    routes,
    unavailableCards: value("unavailable_cards", "count"),
  };
}

export function totals(result: ScenarioResult): {
  requests: number;
  ok: number;
  errors5xx: number;
} {
  const all = Object.values(result.routes);
  return {
    requests: all.reduce((sum, route) => sum + route.requests, 0),
    ok: all.reduce((sum, route) => sum + route.ok, 0),
    errors5xx: all.reduce((sum, route) => sum + route.errors5xx, 0),
  };
}

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const num = (value: number) => integer.format(value);
const percent = (part: number, whole: number) =>
  whole === 0 ? "-" : `${((part / whole) * 100).toFixed(2)}%`;

function duration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function bytes(value: number): string {
  if (value < 1024) return `${num(value)} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function table(rows: string[][]): string {
  const widths = (rows.at(0) ?? []).map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === 0
            ? cell.padEnd(widths[column] ?? 0)
            : cell.padStart(widths[column] ?? 0),
        )
        .join("  "),
    )
    .join("\n");
}

export function formatScenario(result: ScenarioResult, checks: Check[]) {
  const total = totals(result);
  const rate = result.durationS > 0 ? total.requests / result.durationS : 0;
  const lines = [
    `== ${result.title}: ${num(total.requests)} requests in ${result.durationS.toFixed(0)} s (${rate.toFixed(0)} req/s), ${percent(total.ok, total.requests)} OK, ${num(total.errors5xx)} 5xx`,
  ];
  const rows = [["route", "requests", "OK", "p50", "p95", "p99", "max", "5xx"]];
  for (const route of ROUTES) {
    const r = result.routes[route];
    if (!r) continue;
    rows.push([
      route,
      num(r.requests),
      percent(r.ok, r.requests),
      duration(r.p50),
      duration(r.p95),
      duration(r.p99),
      duration(r.max),
      num(r.errors5xx),
    ]);
  }
  lines.push(table(rows));
  if (result.unavailableCards > 0) {
    lines.push(`catalogs with a warning card: ${num(result.unavailableCards)}`);
  }
  const server = result.server;
  if (server) {
    const hosts = Object.entries(server.hosts)
      .sort((a, b) => b[1] - a[1])
      .map(([host, count]) => `${host} ${num(count)}`);
    lines.push(`external calls: ${hosts.join(", ") || "none"}`);
    lines.push(
      `IMDb pages ${num(server.imdbPages)}, items ${num(server.imdbItems)}, max in flight ${num(server.maxInflight)}`,
    );
  }
  const cpu = Object.entries(result.peaks.cpu)
    .map(([name, value]) => `${name} ${value.toFixed(0)}%`)
    .join(", ");
  lines.push(
    `peak RSS ${server ? `${num(server.peakRssMB)} MB` : "-"}, DB connections ${num(result.peaks.dbConnections)} (active ${num(result.peaks.dbActive)})${cpu ? `, peak CPU: ${cpu}` : ""}`,
  );
  for (const check of checks) {
    lines.push(`${check.pass ? "PASS" : "FAIL"}  ${check.label}`);
  }
  return lines.join("\n");
}

/**
 * Pass/fail rules. 5xx budget: 0.1% of the requests of the scenario. The
 * Trakt catalog has its own rule: with Trakt down and no cache, an error
 * answer is expected; a hang is not.
 */
export function evaluate(result: ScenarioResult): Check[] {
  const { trakt_catalog: catalog, ...others } = result.routes;
  const total = totals({ ...result, routes: others });
  const checks: Check[] = [];
  const okRate = total.requests === 0 ? 0 : total.ok / total.requests;
  const minimumOk = { cold: 0.995, warm: 0.999, stale: 0.999, trakt: 0.99 }[
    result.name
  ];
  if (minimumOk !== undefined) {
    checks.push({
      label: `OK >= ${(minimumOk * 100).toFixed(1)}% (${percent(total.ok, total.requests)})`,
      pass: total.requests > 0 && okRate >= minimumOk,
    });
  }
  const budget = Math.floor(total.requests * 0.001);
  checks.push({
    label: `5xx <= ${num(budget)} (0.1% budget): ${num(total.errors5xx)}`,
    pass: total.errors5xx <= budget,
  });
  if (result.name === "trakt") {
    const answers = catalog
      ? `max ${duration(catalog.max)}, ${num(catalog.ok)} of ${num(catalog.requests)} OK`
      : "no request";
    checks.push({
      label: `Trakt catalog answers within 10 s during the outage (${answers})`,
      pass: !!catalog && catalog.max <= 10_000,
    });
    // Expected: 5 per Account for one membership refresh (then the
    // cooldown), plus one list read per Trakt catalog request. The limit is
    // twice that, so a stray retry passes, but a refresh per stream request
    // (the old storm: about 5 calls per request) fails.
    const accounts = result.traktAccounts ?? 0;
    const expected = 5 * accounts + (catalog?.requests ?? 0);
    const limit = 2 * expected;
    const calls = result.server?.hosts["api.trakt.tv"] ?? 0;
    checks.push({
      label: `Trakt calls bounded: at most 2 x (5 per Account + 1 per catalog request) (${num(calls)}, limit ${num(limit)})`,
      pass: !!result.server && calls <= limit,
    });
  }
  return checks;
}

export function formatStorage(
  databaseBytes: { before: number; after: number },
  tables: string[][],
  usage: BucketUsage,
): string {
  const lines = [
    `== Storage after the run (before cleanup)`,
    `database size ${bytes(databaseBytes.after)} (${bytes(databaseBytes.before)} before seeding)`,
    table([
      ["table", "rows (est.)", "total size"],
      ...tables.map(([name = "", rows = "0", size = "0"]) => [
        name,
        num(Number(rows)),
        bytes(Number(size)),
      ]),
    ]),
  ];
  const prefixes = ["history/", "connections/", "watchlists/"];
  for (const prefix of Object.keys(usage)) {
    if (!prefixes.includes(prefix)) prefixes.push(prefix);
  }
  lines.push(
    table([
      ["R2 prefix", "objects", "bytes"],
      ...prefixes.map((prefix) => [
        prefix,
        num(usage[prefix]?.objects ?? 0),
        bytes(usage[prefix]?.bytes ?? 0),
      ]),
    ]),
  );
  return lines.join("\n");
}
