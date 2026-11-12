/**
 * SPIKE (spike/watch-tracking-load): per-instance meter for the load test.
 * Vercel's per-invocation CPU metrics need a paid add-on, so each response
 * carries this instance's cumulative CPU time and busy wall time.
 */
import { randomUUID } from "node:crypto";

const id = randomUUID().slice(0, 8);
const bootAt = Date.now();
let inFlight = 0;
let busySince = 0;
let busyMs = 0;
let requests = 0;

export function meterBegin(): void {
  if (inFlight === 0) busySince = Date.now();
  inFlight += 1;
}

export function meterEnd(): void {
  inFlight -= 1;
  if (inFlight === 0) busyMs += Date.now() - busySince;
}

export function meterCount(): void {
  requests += 1;
}

export function meterHeader(): string {
  const cpu = process.cpuUsage();
  const busy = busyMs + (inFlight > 0 ? Date.now() - busySince : 0);
  return JSON.stringify({
    id,
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    busyMs: busy,
    upMs: Date.now() - bootAt,
    n: requests,
    rssMb: Math.round(process.memoryUsage().rss / 1e6),
  });
}
