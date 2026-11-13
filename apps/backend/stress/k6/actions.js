// Trakt outage: Trakt answers 503 while ACCOUNTS users with Trakt Actions
// open titles (Stremio asks for streams on each one). In the middle of it,
// one of them loads a normal Trakt catalog, which must still answer fast.
import { SharedArray } from "k6/data";
import exec from "k6/execution";
import http from "k6/http";
import { sleep } from "k6";
import { handleSummary, record, route, summaryTrendStats } from "./metrics.js";

const BASE = __ENV.BASE;
const setup = JSON.parse(open(__ENV.ACTIONS));
const accounts = new SharedArray("accounts", () => setup.accounts);
const ITERATIONS = Number(__ENV.ITERATIONS || 20);

route("stream");
route("trakt_catalog");

export const options = {
  summaryTrendStats,
  scenarios: {
    browse: {
      executor: "per-vu-iterations",
      exec: "browse",
      vus: accounts.length,
      iterations: ITERATIONS,
      maxDuration: "5m",
    },
    trakt_catalog: {
      executor: "per-vu-iterations",
      exec: "traktCatalog",
      vus: 1,
      iterations: 2,
      startTime: "10s",
      maxDuration: "6m",
    },
  },
};

export { handleSummary };

const randomTitle = () => 9000000 + Math.floor(Math.random() * 30000);

// One user browsing: opens a movie and an episode about every 2 s. VU IDs
// are shared by both scenarios, so spread iterations over the Accounts.
export function browse() {
  const account = accounts[exec.scenario.iterationInTest % accounts.length];
  const base = `${BASE}/${account}`;
  const params = { tags: { name: "stream" }, timeout: "60s" };
  const movie = `${base}/stream/movie/tt${randomTitle()}.json`;
  record("stream", http.get(movie, params));
  const episode = `${base}/stream/series/tt${randomTitle()}:1:${1 + __ITER}.json`;
  record("stream", http.get(episode, params));
  sleep(2);
}

export function traktCatalog() {
  const { key, listId } = setup.trakt;
  const url = `${BASE}/${key}/catalog/movie/wl-${listId}-movie.json`;
  const params = { tags: { name: "trakt_catalog" }, timeout: "130s" };
  record("trakt_catalog", http.get(url, params));
  sleep(10);
}
