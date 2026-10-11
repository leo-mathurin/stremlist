// Users open their Stremio board: the manifest (cold only, or 10% of the
// time), every catalog of the Account in parallel, then 1 or 2 titles (meta
// and streams). MODE=cold opens each Account once with empty caches;
// MODE=warm picks random Accounts at the arrival rate in STAGES.
import exec from "k6/execution";
import { SharedArray } from "k6/data";
import http from "k6/http";
import { Counter } from "k6/metrics";
import { handleSummary, record, route, summaryTrendStats } from "./metrics.js";

const BASE = __ENV.BASE;
const MODE = __ENV.MODE || "warm";
const targets = new SharedArray("targets", () =>
  JSON.parse(open(__ENV.TARGETS)),
);
// Catalogs that answer with a Stremlist warning card instead of titles.
const unavailableCards = new Counter("unavailable_cards");

for (const name of ["manifest", "catalog", "new_titles", "meta", "stream"]) {
  route(name);
}

const params = (name) => ({ tags: { name }, timeout: "60s" });

export const options = {
  summaryTrendStats,
  scenarios:
    MODE === "cold"
      ? {
          cold: {
            executor: "shared-iterations",
            vus: Number(__ENV.VUS || 100),
            iterations: targets.length,
            maxDuration: "30m",
          },
        }
      : {
          warm: {
            executor: "ramping-arrival-rate",
            startRate: 1,
            timeUnit: "1s",
            preAllocatedVUs: 200,
            maxVUs: Number(__ENV.MAX_VUS || 2000),
            stages: JSON.parse(__ENV.STAGES),
          },
        },
};

export { handleSummary };

export default function () {
  const target =
    MODE === "cold"
      ? targets[exec.scenario.iterationInTest]
      : targets[Math.floor(Math.random() * targets.length)];
  const base = `${BASE}/${target.key}`;
  if (MODE === "cold" || Math.random() < 0.1) {
    record("manifest", http.get(`${base}/manifest.json`, params("manifest")));
  }

  const requests = [];
  for (const list of target.lists) {
    const types = list.mode === "split" ? ["movie", "series"] : [list.mode];
    for (const type of types) {
      const url = `${base}/catalog/${type}/wl-${list.id}-${type}.json`;
      requests.push({ route: "catalog", url });
    }
  }
  if (target.nt) {
    for (const type of ["movie", "series"]) {
      const url = `${base}/catalog/${type}/new-titles-${type}.json`;
      requests.push({ route: "new_titles", url });
    }
  }

  // Stremio loads the board catalogs in parallel.
  const responses = http.batch(
    requests.map((r) => ["GET", r.url, null, params(r.route)]),
  );
  const ids = [];
  responses.forEach((response, i) => {
    record(requests[i].route, response);
    if (response.status !== 200 || requests[i].route !== "catalog") return;
    let metas = [];
    try {
      metas = response.json("metas") || [];
    } catch {
      return;
    }
    if (metas.length === 0) return;
    if (String(metas[0].id).startsWith("stremlist:")) {
      unavailableCards.add(1);
    } else {
      ids.push(metas[Math.floor(Math.random() * metas.length)].id);
    }
  });

  // Open 1 or 2 titles: Stremio asks every addon for meta and streams.
  for (const id of ids.slice(0, 1 + Math.floor(Math.random() * 2))) {
    record("meta", http.get(`${base}/meta/movie/${id}.json`, params("meta")));
    record(
      "stream",
      http.get(`${base}/stream/movie/${id}.json`, params("stream")),
    );
  }
}
