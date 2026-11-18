import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ProviderId } from "@stremlist/shared/providers";
import {
  earliestOutage,
  outageCopy,
  outageProviders,
  recoveredCopy,
  recoveredProviders,
} from "../src/lib/provider-outages.ts";

type Status = Record<
  ProviderId,
  { enabled: boolean; outageSince: string | null }
>;

function status(overrides: Partial<Status> = {}) {
  const up = { enabled: true, outageSince: null };
  return {
    imdb: up,
    trakt: up,
    simkl: up,
    mdblist: up,
    justwatch: up,
    senscritique: up,
    letterboxd: up,
    ...overrides,
  };
}

const EARLY = "2026-11-16T10:00:00.000Z";
const LATE = "2026-11-16T11:00:00.000Z";

describe("provider outages", () => {
  test("lists the Providers with an outage in Provider order", () => {
    const current = status({
      letterboxd: { enabled: true, outageSince: LATE },
      trakt: { enabled: true, outageSince: EARLY },
    });
    assert.deepEqual(outageProviders(current), ["trakt", "letterboxd"]);
    assert.equal(earliestOutage(["trakt", "letterboxd"], current), EARLY);
  });

  test("leaves out an unavailable Provider: its own label says so", () => {
    const current = status({ trakt: { enabled: false, outageSince: EARLY } });
    assert.deepEqual(outageProviders(current), []);
  });

  test("finds the Providers that work again, not the ones turned off", () => {
    const current = status({
      simkl: { enabled: true, outageSince: EARLY },
      justwatch: { enabled: false, outageSince: null },
    });
    assert.deepEqual(
      recoveredProviders(["trakt", "simkl", "justwatch"], current),
      ["trakt"],
    );
  });

  test("names one or several Providers in plain words", () => {
    assert.equal(outageCopy(["trakt"]).title, "Trakt is having problems");
    assert.equal(
      outageCopy(["trakt", "simkl", "mdblist"]).title,
      "Trakt, Simkl and MDBList are having problems",
    );
    assert.match(outageCopy(["trakt"]).body, /cannot reach it/);
    assert.match(outageCopy(["trakt", "simkl"]).body, /cannot reach them/);
    assert.equal(recoveredCopy(["imdb"]), "IMDb is working again.");
    assert.equal(
      recoveredCopy(["imdb", "trakt"]),
      "IMDb and Trakt are working again.",
    );
  });

  test("uses no em dash in the copy", () => {
    for (const ids of [["trakt"], ["trakt", "simkl"]] as ProviderId[][]) {
      const { title, body } = outageCopy(ids);
      assert.doesNotMatch(`${title} ${body} ${recoveredCopy(ids)}`, /—/);
    }
  });
});
