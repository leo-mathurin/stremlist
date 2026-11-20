import type { JsonBodyType } from "msw";
import { http, HttpResponse } from "msw";
import { describe, test } from "vite-plus/test";
import assert from "node:assert/strict";
import { useMswServer } from "../../test/helpers/msw.test-utils";
import {
  StremioSessionError,
  StremioUnavailableError,
  createLinkCode,
  getLibraryItems,
  installStremlist,
  isThisStremlist,
  readLinkCode,
  updateInstalledStremlist,
} from "../stremio";
import type { StremioAddon } from "../stremio";
import { z } from "zod";

const STREMIO_API = "https://api.strem.io/api";
const LINK_API = "https://link.stremio.com/api/v2";
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
const stremlist = (catalog: string) => ({
  transportUrl: ADDON_URL,
  transportName: "http",
  manifest: manifest(catalog),
  flags: {},
});

const stremioAddon = z
  .object({
    transportUrl: z.string(),
    transportName: z.string().optional(),
    manifest: z.object({ id: z.string() }).loose(),
    flags: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

const stremioRequest = z.object({
  authKey: z.string(),
  addons: z.array(stremioAddon).optional(),
  profileId: z.string().optional(),
  addAddon: stremioAddon.optional(),
});

const server = useMswServer();

function fakeStremio(
  collection: StremioAddon[],
  answer: Record<string, () => JsonBodyType> = {},
  profiles?: Record<string, { addons: StremioAddon[] }>,
) {
  const state = {
    collection: structuredClone(collection),
    profiles: structuredClone(profiles ?? {}),
    writes: 0,
    profileWrites: new Array<string>(),
  };
  const respond = async (request: Request) => {
    const method = request.url.split("/api/")[1];
    const override = answer[method] as (() => JsonBodyType) | undefined;
    if (override) return HttpResponse.json(override());
    const body = stremioRequest.parse(await request.json());
    assert.equal(body.authKey, KEY);
    if (method === "getUser") {
      return HttpResponse.json({
        result: profiles ? { features: { profiles: 6 } } : {},
      });
    }
    if (method === "addonCollectionGet") {
      return HttpResponse.json({ result: { addons: state.collection } });
    }
    if (method === "addonCollectionSet") {
      state.writes++;
      state.collection = structuredClone(body.addons ?? []);
      return HttpResponse.json({ result: { success: true } });
    }
    if (method === "premiumPrefs/getProfilesAddons" && profiles) {
      return HttpResponse.json({ result: { profiles: state.profiles } });
    }
    if (method === "premiumPrefs/setProfileAddons" && profiles) {
      assert.ok(body.profileId);
      const { addAddon } = body;
      assert.ok(addAddon);
      const profile = state.profiles[body.profileId];
      const index = profile.addons.findIndex(
        (addon) => addon.transportUrl === addAddon.transportUrl,
      );
      assert.notEqual(index, -1);
      profile.addons[index] = addAddon;
      state.profileWrites.push(body.profileId);
      return HttpResponse.json({ result: { success: true } });
    }
    throw new Error(`unexpected request ${request.url}`);
  };
  server.use(http.post(`${STREMIO_API}/*`, ({ request }) => respond(request)));
  return { state, respond };
}

function answerLink(path: "create" | "read", body: JsonBodyType) {
  server.use(http.get(`${LINK_API}/${path}`, () => HttpResponse.json(body)));
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
    const { state } = fakeStremio(before);
    assert.equal(
      await updateInstalledStremlist(KEY, ADDON_URL, manifest("Renamed")),
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
    const { state } = fakeStremio([cinemeta, stremlist("Renamed")]);
    assert.equal(
      await updateInstalledStremlist(KEY, ADDON_URL, manifest("Renamed")),
      "unchanged",
    );
    assert.equal(state.writes, 0);
  });

  test("reports a removed install without adding it back", async () => {
    const { state } = fakeStremio([cinemeta, torrentio]);
    assert.equal(
      await updateInstalledStremlist(KEY, ADDON_URL, manifest("Renamed")),
      "missing",
    );
    assert.equal(state.writes, 0);
    assert.deepEqual(state.collection, [cinemeta, torrentio]);
  });

  test("updates only profiles with this configuration and preserves addon order", async () => {
    const otherStremlist = {
      ...stremlist("Their list"),
      transportUrl: "https://api.stremlist.com/sl_Account0002/manifest.json",
    };
    const { state } = fakeStremio(
      [stremlist("Renamed")],
      {},
      {
        stale: { addons: [torrentio, stremlist("Old"), cinemeta] },
        current: { addons: [stremlist("Renamed")] },
        different: { addons: [otherStremlist] },
        absent: { addons: [cinemeta] },
      },
    );

    assert.equal(
      await updateInstalledStremlist(KEY, ADDON_URL, manifest("Renamed")),
      "updated",
    );
    assert.equal(state.writes, 0);
    assert.deepEqual(state.profileWrites, ["stale"]);
    assert.deepEqual(state.profiles, {
      stale: { addons: [torrentio, stremlist("Renamed"), cinemeta] },
      current: { addons: [stremlist("Renamed")] },
      different: { addons: [otherStremlist] },
      absent: { addons: [cinemeta] },
    });
    assert.equal(
      await updateInstalledStremlist(KEY, ADDON_URL, manifest("Renamed")),
      "unchanged",
    );
    assert.deepEqual(state.profileWrites, ["stale"]);
  });

  test("updates an installation that exists only on a secondary profile", async () => {
    const { state } = fakeStremio(
      [cinemeta],
      {},
      {
        secondary: { addons: [stremlist("Old")] },
      },
    );
    assert.equal(
      await updateInstalledStremlist(KEY, ADDON_URL, manifest("Renamed")),
      "updated",
    );
    assert.deepEqual(state.collection, [cinemeta]);
    assert.deepEqual(state.profiles.secondary.addons, [stremlist("Renamed")]);
  });

  test("concurrent configurations preserve both updates on the same profile", async () => {
    const otherUrl = "https://api.stremlist.com/sl_Account0002/manifest.json";
    const otherManifest = {
      ...manifest("Their list"),
      id: "com.stremlist.sl_Account0002",
    };
    const otherBefore = {
      ...stremlist("Old"),
      transportUrl: otherUrl,
      manifest: otherManifest,
    };
    const { state, respond } = fakeStremio(
      [cinemeta],
      {},
      {
        secondary: { addons: [stremlist("Old"), torrentio, otherBefore] },
      },
    );
    const bothWriting = Promise.withResolvers<void>();
    let pendingWrites = 0;
    server.use(
      http.post(
        `${STREMIO_API}/premiumPrefs/setProfileAddons`,
        async ({ request }) => {
          pendingWrites++;
          if (pendingWrites === 2) bothWriting.resolve();
          await bothWriting.promise;
          return respond(request);
        },
      ),
    );
    const otherAfter = { ...otherManifest, version: "2.1.0" };

    assert.deepEqual(
      await Promise.all([
        updateInstalledStremlist(KEY, ADDON_URL, manifest("Renamed")),
        updateInstalledStremlist(KEY, otherUrl, otherAfter),
      ]),
      ["updated", "updated"],
    );
    assert.deepEqual(state.profiles.secondary.addons, [
      stremlist("Renamed"),
      torrentio,
      { ...otherBefore, manifest: otherAfter },
    ]);
  });

  test.each(["getUser", "premiumPrefs/getProfilesAddons"])(
    "updates the linked collection while %s is pending and asks for a retry on failure",
    async (method) => {
      const { state, respond } = fakeStremio(
        [stremlist("Old")],
        {},
        { secondary: { addons: [stremlist("Old")] } },
      );
      const linkedWrite = Promise.withResolvers<void>();
      server.use(
        http.post(`${STREMIO_API}/${method}`, async () => {
          await linkedWrite.promise;
          return HttpResponse.json({ error: { code: 500 } });
        }),
        http.post(`${STREMIO_API}/addonCollectionSet`, async ({ request }) => {
          const response = await respond(request);
          linkedWrite.resolve();
          return response;
        }),
      );
      await assert.rejects(
        updateInstalledStremlist(KEY, ADDON_URL, manifest("Renamed")),
        StremioUnavailableError,
      );
      assert.deepEqual(state.collection, [stremlist("Renamed")]);
      assert.deepEqual(state.profileWrites, []);
    },
  );

  test("updates only the linked collection when the session belongs to a secondary profile", async () => {
    const { state } = fakeStremio([stremlist("Old")], {
      getUser: () => ({
        result: { parent_id: "admin", features: { profiles: 6 } },
      }),
    });
    assert.equal(
      await updateInstalledStremlist(KEY, ADDON_URL, manifest("Renamed")),
      "updated",
    );
    assert.deepEqual(state.collection, [stremlist("Renamed")]);
  });

  test("reports a profile write that Stremio did not keep", async () => {
    const { state } = fakeStremio(
      [stremlist("Old")],
      {
        "premiumPrefs/setProfileAddons": () => ({ result: { success: true } }),
      },
      {
        secondary: { addons: [stremlist("Old")] },
      },
    );
    await assert.rejects(
      updateInstalledStremlist(KEY, ADDON_URL, manifest("Renamed")),
      StremioUnavailableError,
    );
    assert.deepEqual(state.collection, [stremlist("Renamed")]);
    assert.deepEqual(state.profiles.secondary.addons, [stremlist("Old")]);
  });

  test("tells a signed-out session apart from an outage", async () => {
    fakeStremio([stremlist("Old")], {
      addonCollectionGet: () => ({
        error: { code: 1, message: "Session does not exist" },
      }),
    });
    await assert.rejects(
      updateInstalledStremlist(KEY, ADDON_URL, manifest("Renamed")),
      StremioSessionError,
    );
    server.use(http.post(`${STREMIO_API}/:method`, () => HttpResponse.error()));
    await assert.rejects(
      updateInstalledStremlist(KEY, ADDON_URL, manifest("Renamed")),
      StremioUnavailableError,
    );
  });

  test("fails when Stremio does not keep the write", async () => {
    const { state } = fakeStremio([stremlist("Old")], {
      addonCollectionSet: () => ({ result: { success: true } }),
    });
    await assert.rejects(
      updateInstalledStremlist(KEY, ADDON_URL, manifest("Renamed")),
      StremioUnavailableError,
    );
    assert.deepEqual(state.collection, [stremlist("Old")]);
  });

  test("counts an accepted write when only the check gets no answer", async () => {
    const { state, respond } = fakeStremio([cinemeta, stremlist("Old")]);
    let reads = 0;
    server.use(
      http.post(`${STREMIO_API}/addonCollectionGet`, ({ request }) =>
        ++reads === 2
          ? new HttpResponse("busy", { status: 503 })
          : respond(request),
      ),
    );
    assert.equal(
      await updateInstalledStremlist(KEY, ADDON_URL, manifest("Renamed")),
      "updated",
    );
    assert.deepEqual(state.collection, [cinemeta, stremlist("Renamed")]);
  });
});

describe("installing Stremlist again", () => {
  test("adds it at the end when it is missing", async () => {
    const { state } = fakeStremio([cinemeta]);
    await installStremlist(KEY, ADDON_URL, manifest("Renamed"));
    assert.deepEqual(state.collection, [cinemeta, stremlist("Renamed")]);
  });

  test("adds nothing when it is already there", async () => {
    const { state } = fakeStremio([cinemeta, stremlist("Old")]);
    await installStremlist(KEY, ADDON_URL, manifest("Renamed"));
    assert.equal(state.writes, 0);
  });
});

describe("reading library items", () => {
  test("reads null or odd state fields as absent", async () => {
    server.use(
      http.post(`${STREMIO_API}/datastoreGet`, () =>
        HttpResponse.json({
          result: [
            {
              _id: "tt0111161",
              type: "movie",
              _mtime: null,
              state: { video_id: null, watched: null, lastWatched: null },
            },
            { _id: "tt0944947", type: "series", state: { timeWatched: "12" } },
            { _id: "tt0068646", type: "movie", state: null },
          ],
        }),
      ),
    );
    assert.deepEqual(await getLibraryItems(KEY, ["tt0111161"]), [
      {
        _id: "tt0111161",
        type: "movie",
        _mtime: undefined,
        state: {
          video_id: undefined,
          watched: undefined,
          lastWatched: undefined,
        },
      },
      { _id: "tt0944947", type: "series", state: { timeWatched: undefined } },
      { _id: "tt0068646", type: "movie", state: undefined },
    ]);
  });
});

describe("linking with a Stremio code", () => {
  test("reads the code and its page, and waits for the confirmation", async () => {
    answerLink("create", {
      result: {
        success: true,
        code: "AB12",
        link: "https://link.stremio.com/AB12",
      },
    });
    assert.deepEqual(await createLinkCode(), {
      code: "AB12",
      link: "https://link.stremio.com/AB12",
    });

    answerLink("read", {
      error: { code: 101, message: "Invalid or expired token" },
    });
    assert.equal(await readLinkCode("AB12"), null);

    answerLink("read", { result: { success: true, authKey: KEY } });
    assert.equal(await readLinkCode("AB12"), KEY);
  });

  test("tells an outage of the code page apart from a pending code", async () => {
    server.use(
      http.get(`${LINK_API}/read`, () =>
        HttpResponse.json({ error: { message: "busy" } }, { status: 503 }),
      ),
    );
    await assert.rejects(readLinkCode("AB12"), StremioUnavailableError);
  });

  test("refuses a code that the link token cannot carry", async () => {
    answerLink("create", {
      result: { code: "AB-12", link: "https://link.stremio.com/AB-12" },
    });
    await assert.rejects(createLinkCode(), StremioUnavailableError);
  });

  test("refuses a code answer without an https page", async () => {
    answerLink("create", {
      result: { code: "AB12", link: "javascript:alert(1)" },
    });
    await assert.rejects(createLinkCode(), StremioUnavailableError);
  });
});
