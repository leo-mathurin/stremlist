// Per-route metrics shared by the k6 scripts. run.ts reads them back from
// the JSON summary: t_<route> (duration), ok_<route> (status 200 rate) and
// e5xx_<route> (5xx and network errors).
import { Counter, Rate, Trend } from "k6/metrics";

const routes = {};

export function route(name) {
  routes[name] = {
    duration: new Trend(`t_${name}`, true),
    ok: new Rate(`ok_${name}`),
    errors: new Counter(`e5xx_${name}`),
  };
}

export function record(name, response) {
  const metrics = routes[name];
  metrics.duration.add(response.timings.duration);
  metrics.ok.add(response.status === 200);
  metrics.errors.add(response.status >= 500 || response.status === 0 ? 1 : 0);
}

export const summaryTrendStats = [
  "avg",
  "min",
  "med",
  "p(95)",
  "p(99)",
  "max",
  "count",
];

export function handleSummary(data) {
  return { [__ENV.SUMMARY || "summary.json"]: JSON.stringify(data) };
}
