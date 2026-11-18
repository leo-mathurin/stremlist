import type { RpcHandler } from "./rpc";
import { numberOf } from "./rpc";
import type { Row } from "./store";
import { db, now } from "./store";

const recordProviderProbe: RpcHandler = (args) => {
  const provider = args.p_provider;
  if (typeof provider !== "string") throw new Error("p_provider is required");
  const ok = args.p_ok === true;
  const threshold =
    args.p_threshold === undefined
      ? 2
      : numberOf(args.p_threshold, "p_threshold");
  const error =
    typeof args.p_error === "string" ? args.p_error.slice(0, 500) : null;
  const table = db.getTable("provider_outages");
  let row: Row | undefined = table.find((r) => r.provider === provider);
  if (!row) {
    row = { provider, failures: 0, outage_since: null };
    table.push(row);
  }
  const failures = ok ? 0 : numberOf(row.failures, "failures") + 1;
  row.outage_since = ok
    ? null
    : (row.outage_since ?? (failures >= threshold ? now() : null));
  row.failures = failures;
  row.checked_at = now();
  row.last_error = ok ? null : error;
  return { data: { ...row }, error: null };
};

export const providerOutageRpcs = {
  record_provider_probe: recordProviderProbe,
};
