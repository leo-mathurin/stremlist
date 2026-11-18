import type { RpcHandler } from "./rpc";
import { numberOf } from "./rpc";
import { db } from "./store";

const claimMonitorRun: RpcHandler = (args) => {
  const name = args.p_name;
  if (typeof name !== "string") throw new Error("p_name is required");
  const intervalMs =
    numberOf(args.p_interval_seconds, "p_interval_seconds") * 1000;
  const table = db.getTable("monitor_runs");
  const row = table.find((r) => r.name === name);
  const startedAt = new Date().toISOString();
  if (!row) {
    table.push({
      name,
      started_at: startedAt,
      finished_at: null,
      summary: null,
    });
    return { data: true, error: null };
  }
  if (Date.now() - Date.parse(String(row.started_at)) < intervalMs)
    return { data: false, error: null };
  row.started_at = startedAt;
  return { data: true, error: null };
};

export const monitorRunRpcs = { claim_monitor_run: claimMonitorRun };
