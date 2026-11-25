import type { ProviderId } from "@stremlist/shared/providers";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { db } from "../../../test/helpers/mock-supabase";
import { useMswServer } from "../../../test/helpers/msw.test-utils";
import { ALARM_ACTIVE_MS, listAlarms, readListAlarms } from "../list-alarm";
import { heartbeatPings } from "../list-checks";

useMswServer();

function rows(
  ref: (index: number) => string,
  reasons: (string | null)[],
  provider = "letterboxd",
) {
  return reasons.map((failure_reason, index) => ({
    provider,
    source_ref: ref(index),
    failure_reason,
    last_attempt_at: new Date(Date.UTC(2026, 10, 24, 16, index)).toISOString(),
  }));
}
const diary = (index: number) => `users/user${index}/diary`;
const watchlist = (index: number) => `users/user${index}/watchlist`;

describe("listAlarms", () => {
  it("alarms when 3 Source lists of one list type fail as unavailable", () => {
    expect(
      listAlarms(
        rows(diary, [
          "unavailable",
          "unavailable",
          "unavailable",
          ...Array<null>(20).fill(null),
        ]),
      ),
    ).toEqual([
      {
        type: "letterboxd:users/{user}/diary",
        provider: "letterboxd",
        failing: 3,
        total: 23,
      },
    ]);
  });

  it("alarms for 2 failures only when they are at least half of the type", () => {
    expect(
      listAlarms(rows(diary, ["unavailable", "unavailable", null, null])),
    ).toHaveLength(1);
    expect(
      listAlarms(rows(diary, ["unavailable", "unavailable", null, null, null])),
    ).toEqual([]);
  });

  it("never alarms for one failure, or for the user's own problems", () => {
    expect(listAlarms(rows(diary, ["unavailable"]))).toEqual([]);
    expect(
      listAlarms(
        rows(diary, [
          "private",
          "not_found",
          "needs_connection",
          "disabled",
          "coming_soon",
          "premium_only",
        ]),
      ),
    ).toEqual([]);
  });

  it("counts a public Source list in several Lists once with its last refresh, a Connection read for each List", () => {
    const films = (index: number) =>
      index < 2 ? "users/exotic33/films" : `users/user${index}/films`;
    expect(
      listAlarms(rows(films, ["unavailable", "unavailable", null, null])),
    ).toEqual([]);
    const recovered = (index: number) =>
      index < 3 ? "users/exotic33/films" : "users/chi17f/films";
    expect(
      listAlarms(rows(recovered, ["unavailable", null, null, "unavailable"])),
    ).toEqual([]);
    expect(
      listAlarms(
        rows(
          () => "me/history",
          ["unavailable", "unavailable", "unavailable"],
          "trakt",
        ),
      ),
    ).toMatchObject([{ type: "trakt:me/history", failing: 3, total: 3 }]);
  });

  it("counts each list type on its own", () => {
    const alarms = listAlarms([
      ...rows(diary, ["unavailable", "unavailable"]),
      ...rows(watchlist, ["unavailable", null, null, null, null]),
    ]);
    expect(alarms.map((alarm) => alarm.type)).toEqual([
      "letterboxd:users/{user}/diary",
    ]);
  });
});

describe("readListAlarms", () => {
  beforeEach(() => db.reset());

  it("reads every page of sync statuses, and only Source lists refreshed recently", async () => {
    const now = Date.now();
    const table = db.getTable("list_sync_status");
    for (let index = 0; index < 2503; index++)
      table.push({
        list_id: `list-${String(index).padStart(5, "0")}`,
        provider: "imdb",
        source_ref: `ur${10_000_000 + index}`,
        failure_reason: index >= 2500 ? "unavailable" : null,
        last_attempt_at: new Date(now - 60_000).toISOString(),
      });
    for (let index = 0; index < 3; index++)
      table.push({
        list_id: `old-${index}`,
        provider: "imdb",
        source_ref: `ls${100_000_000 + index}`,
        failure_reason: "unavailable",
        last_attempt_at: new Date(now - ALARM_ACTIVE_MS - 60_000).toISOString(),
      });

    expect(await readListAlarms(now)).toEqual({
      alarms: [
        {
          type: "imdb:ur/watchlist",
          provider: "imdb",
          failing: 3,
          total: 2503,
        },
      ],
    });
  });
});

describe("heartbeatPings", () => {
  const report = (
    provider: ProviderId,
    failures: string[] = [],
    checked = true,
  ) => ({ provider, checked, failures });

  it("sends one ping per URL, which fails when one Provider on it fails", () => {
    const shared = "https://beat.example/apps";
    const urls: Partial<Record<ProviderId, string>> = {
      trakt: shared,
      simkl: shared,
      mdblist: shared,
      imdb: "https://beat.example/imdb",
    };
    expect(
      heartbeatPings(
        [
          report("imdb"),
          report("trakt"),
          report("simkl", ["simkl:me/history (me/history): 0 entries"]),
          report("mdblist", ["mdblist probe: 503"]),
        ],
        (provider) => urls[provider],
      ),
    ).toEqual([
      { url: "https://beat.example/imdb", failures: [] },
      {
        url: shared,
        failures: [
          "simkl:me/history (me/history): 0 entries",
          "mdblist probe: 503",
        ],
      },
    ]);
  });

  it("sends no ping to a URL whose Providers nothing checked, unless the alarm failed one", () => {
    const urlOf = (provider: ProviderId) =>
      provider === "justwatch" ? "https://beat.example/jw" : undefined;
    expect(
      heartbeatPings([report("justwatch", [], false), report("imdb")], urlOf),
    ).toEqual([]);
    expect(
      heartbeatPings(
        [report("justwatch", ["justwatch:{list}: 3 of 4 Lists fail"], false)],
        urlOf,
      ),
    ).toEqual([
      {
        url: "https://beat.example/jw",
        failures: ["justwatch:{list}: 3 of 4 Lists fail"],
      },
    ]);
  });
});
