import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  StremioSessionError,
  StremioUnavailableError,
  createLinkCode,
  installStremlist,
  isThisStremlist,
  readLinkCode,
  updateInstalledStremlist,
  type StremioAddon,
} from "../src/lib/stremio-sync.ts";

const ADDON_URL = "https://api.stremlist.com/sl_Account0001/manifest.json";
const KEY = "session-key";

const manifest = (catalog: string) => ({
  id: "com.stremlist.sl_Account0001",
  name: "Stremlist",
  version: "2.0.0",
  catalogs: [{ id: "c1", type: "movie", name: catalog }],
});

const cinemeta: StremioAddon = {
  transportUrl: "https://v3-cinemeta.strem.io/manifest.json",
  transportName: "",
  manifest: { id: "com.linvo.cinemeta", name: "Cinemeta", version: "3.0.14" },
  flags: { official: true, protected: true },
};
const torrentio: StremioAddon = {
  transportUrl: "https://torrentio.strem.fun/manifest.json",
  manifest: { id: "com.stremio.torrentio.addon", name: "Torrentio" },
};
const stremlist = (catalog: string): StremioAddon => ({
  transportUrl: ADDON_URL,
  transportName: "http",
  manifest: manifest(catalog),
  flags: {},
});

/**
 * A Stremio account and a Stremlist server in memory. `served` is what the
 * Addon URL answers; `answer` overrides the API answer per method.
 */
function fakeStremio(
  collection: StremioAddon[],
  served = manifest("Renamed"),
  answer: Record<string, () => unknown> = {},
) {
  const state = { collection: structuredClone(collection), writes: 0 };
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === ADDON_URL) return Response.json(served);
    const method = url.split("/api/")[1];
    if (answer[method]) return Response.json(answer[method]());
    const body = JSON.parse(String(init?.body)) as {
      authKey: string;
      addons?: StremioAddon[];
    };
    assert.equal(body.authKey, KEY);
    if (method === "addonCollectionGet") {
      return Response.json({ result: { addons: state.collection } });
    }
    if (method === "addonCollectionSet") {
      state.writes++;
      state.collection = structuredClone(body.addons ?? []);
      return Response.json({ result: { success: true } });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return { state, fetchImpl };
}

describe("finding this Stremlist in a collection", () => {
  test("matches the Account path on the same host", () => {
    assert.ok(isThisStremlist(stremlist("A"), ADDON_URL));
  });

  test("matches an install from an older Stremlist domain by its manifest", () => {
    const old = {
      ...stremlist("A"),
      transportUrl: "https://stremlist.com/sl_Account0001/manifest.json",
    };
    assert.ok(isThisStremlist(old, ADDON_URL));
  });

  test("ignores another Account and another addon with the same path", () => {
    const other = {
      ...stremlist("A"),
      transportUrl: "https://api.stremlist.com/sl_Account0002/manifest.json",
    };
    assert.equal(isThisStremlist(other, ADDON_URL), false);
    const lookalike: StremioAddon = {
      transportUrl: "https://evil.example/sl_Account0001/manifest.json",
      manifest: { id: "org.example.lookalike" },
    };
    assert.equal(isThisStremlist(lookalike, ADDON_URL), false);
  });
});

describe("updating the installed Stremlist", () => {
  test("replaces only its manifest and keeps every other addon in order", async () => {
    const before = [cinemeta, stremlist("Old"), torrentio];
    const { state, fetchImpl } = fakeStremio(before);
    assert.equal(
      await updateInstalledStremlist(KEY, ADDON_URL, fetchImpl),
      "updated",
    );
    assert.equal(state.writes, 1);
    assert.deepEqual(state.collection, [
      cinemeta,
      stremlist("Renamed"),
      torrentio,
    ]);
  });

  test("writes nothing when Stremio already reads the saved setup", async () => {
    const { state, fetchImpl } = fakeStremio([cinemeta, stremlist("Renamed")]);
    assert.equal(
      await updateInstalledStremlist(KEY, ADDON_URL, fetchImpl),
      "unchanged",
    );
    assert.equal(state.writes, 0);
  });

  test("reports a removed install without adding it back", async () => {
    const { state, fetchImpl } = fakeStremio([cinemeta, torrentio]);
    assert.equal(
      await updateInstalledStremlist(KEY, ADDON_URL, fetchImpl),
      "missing",
    );
    assert.equal(state.writes, 0);
    assert.deepEqual(state.collection, [cinemeta, torrentio]);
  });

  test("tells a signed-out session apart from an outage", async () => {
    const signedOut = fakeStremio([stremlist("Old")], undefined, {
      addonCollectionGet: () => ({
        error: { code: 1, message: "Session does not exist" },
      }),
    });
    await assert.rejects(
      updateInstalledStremlist(KEY, ADDON_URL, signedOut.fetchImpl),
      StremioSessionError,
    );
    const down = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    await assert.rejects(
      updateInstalledStremlist(KEY, ADDON_URL, down),
      StremioUnavailableError,
    );
  });

  test("fails when Stremio does not keep the write", async () => {
    const { state, fetchImpl } = fakeStremio([stremlist("Old")], undefined, {
      addonCollectionSet: () => ({ result: { success: true } }),
    });
    await assert.rejects(
      updateInstalledStremlist(KEY, ADDON_URL, fetchImpl),
      StremioUnavailableError,
    );
    assert.deepEqual(state.collection, [stremlist("Old")]);
  });
});

describe("installing Stremlist again", () => {
  test("adds it at the end when it is missing", async () => {
    const { state, fetchImpl } = fakeStremio([cinemeta]);
    await installStremlist(KEY, ADDON_URL, fetchImpl);
    assert.deepEqual(state.collection, [cinemeta, stremlist("Renamed")]);
  });

  test("adds nothing when it is already there", async () => {
    const { state, fetchImpl } = fakeStremio([cinemeta, stremlist("Old")]);
    await installStremlist(KEY, ADDON_URL, fetchImpl);
    assert.equal(state.writes, 0);
  });
});

describe("linking with a Stremio code", () => {
  test("reads the code and its page, and waits for the confirmation", async () => {
    const created = (async () =>
      Response.json({
        result: {
          success: true,
          code: "AB12",
          link: "https://link.stremio.com/AB12",
        },
      })) as typeof fetch;
    assert.deepEqual(await createLinkCode(created), {
      code: "AB12",
      link: "https://link.stremio.com/AB12",
    });

    const pending = (async () =>
      Response.json({
        error: { code: 101, message: "Invalid or expired token" },
      })) as typeof fetch;
    assert.equal(await readLinkCode("AB12", pending), null);

    const approved = (async () =>
      Response.json({
        result: { success: true, authKey: KEY },
      })) as typeof fetch;
    assert.equal(await readLinkCode("AB12", approved), KEY);
  });

  test("refuses a code answer without an https page", async () => {
    const odd = (async () =>
      Response.json({
        result: { code: "AB12", link: "javascript:alert(1)" },
      })) as typeof fetch;
    await assert.rejects(createLinkCode(odd), StremioUnavailableError);
  });
});
