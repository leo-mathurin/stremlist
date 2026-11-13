import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import app from "../index.js";
import { movie, seedLegacyAccount, seedList } from "./helpers/fixtures.js";
import { cache } from "./helpers/mock-list-cache.js";
import { resetProviders } from "./helpers/mock-registry.js";
import { db, resetRpc, supabase } from "./helpers/mock-supabase.js";
import {
  configBody,
  metaBody,
  metasBody,
  readJson,
  stremioManifest,
} from "./helpers/json.js";

vi.mock("../lib/supabase", () => import("./helpers/mock-supabase.js"));
vi.mock("../services/list-cache", () => import("./helpers/mock-list-cache.js"));
vi.mock("../providers/registry", () => import("./helpers/mock-registry.js"));
vi.mock("../lib/resend", () => import("../__tests__/helpers/mock-resend"));

// Every Addon URL key that a v1 install can have. v1 served any key until
// 2026-09-01, then `ur` + 4 or more digits and `p.` handles. Production
// still holds all these shapes as `legacy_imdb_user_id`.
const LEGACY_KEYS = [
  ["an IMDb user ID", "ur12345678"],
  ["a short IMDb user ID", "ur12"],
  ["a p. handle", "p.Ab3dEf9hIjkLmn0pQrStuvWxyz"],
  ["an IMDb list ID", "ls123456789"],
  ["a ur ID with letters", "ur12345678ls123456789"],
] as const;

// Keys that v1 stored but that no Stremlist URL can use: they never reach the
// database.
const JUNK_KEYS = [
  "123",
  "potato",
  "YOUR_IMDB_ID",
  "ur12345678'--",
  "sl_short",
  "UR12345678",
] as const;

const LIST_ID = "11111111-1111-4111-8111-111111111111";
const SHAWSHANK = movie("tt0111161", { name: "The Shawshank Redemption" });

beforeEach(() => {
  db.reset();
  resetRpc();
  cache.reset();
  resetProviders();
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

function seedInstall(key: string) {
  const account = seedLegacyAccount(key, { rpdb_api_key: "rpdb" });
  seedList(account.id, { id: LIST_ID, source_ref: key });
  cache.seed(LIST_ID, [SHAWSHANK]);
  return account;
}

describe.each(LEGACY_KEYS)("a v1 install keyed by %s", (_label, key) => {
  const path = (suffix: string) => `/${encodeURIComponent(key)}${suffix}`;

  it("serves its manifest with the historic ID", async () => {
    seedInstall(key);

    const res = await app.request(path("/manifest.json"));

    expect(res.status).toBe(200);
    const value = await readJson(res, stremioManifest);
    expect(value.id).toBe(`com.stremlist.${key}`);
    expect(value.behaviorHints.configurationRequired).toBe(false);
    expect(value.catalogs.map((catalog) => catalog.id)).toEqual([
      `wl-${LIST_ID}-movie`,
      `wl-${LIST_ID}-series`,
    ]);
  });

  it("serves its catalogs", async () => {
    seedInstall(key);

    const res = await app.request(
      path(`/catalog/movie/wl-${LIST_ID}-movie.json`),
    );

    expect(res.status).toBe(200);
    const body = await readJson(res, metasBody);
    expect(body.metas.map((meta) => meta.id)).toEqual([SHAWSHANK.id]);
  });

  it("serves the meta of its cached Titles", async () => {
    seedInstall(key);

    const res = await app.request(path(`/meta/movie/${SHAWSHANK.id}.json`));

    expect(res.status).toBe(200);
    const body = await readJson(res, metaBody);
    expect(body.meta?.id).toBe(SHAWSHANK.id);
  });

  it("answers the stream route with no entries", async () => {
    seedInstall(key);

    const res = await app.request(path(`/stream/movie/${SHAWSHANK.id}.json`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ streams: [], cacheMaxAge: 0 });
  });

  it("opens its configure page", async () => {
    const res = await app.request(path("/configure"));

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/configure");
    expect(location.searchParams.get("account")).toBe(key);
  });

  it("serves its configuration to the configure page", async () => {
    seedInstall(key);

    const res = await app.request(path("/config"));

    expect(res.status).toBe(200);
    const body = await readJson(res, configBody);
    expect(body).toMatchObject({ access: "legacy", accountId: null });
    expect(body.lists.map((list) => list.sourceRef)).toEqual([key]);
  });
});

describe("the first manifest request of an install that never saved", () => {
  it.each([
    ["an IMDb user ID", "ur12345678"],
    ["a p. handle", "p.someone"],
  ])("creates a legacy Account for %s", async (_label, key) => {
    const res = await app.request(`/${key}/manifest.json`);

    expect(res.status).toBe(200);
    const [account] = db.getTable("accounts");
    expect(account).toMatchObject({ legacy_imdb_user_id: key });
    expect(db.getTable("lists")).toMatchObject([
      { account_id: account.id, provider: "imdb", source_ref: key },
    ]);
  });

  it.each([
    ["a short IMDb user ID", "ur12"],
    ["an IMDb list ID", "ls123456789"],
    ["a ur ID with letters", "ur12345678ls123456789"],
  ])(
    "creates nothing for %s, which v1 stopped creating",
    async (_label, key) => {
      const res = await app.request(`/${key}/manifest.json`);

      expect(res.status).toBe(200);
      const value = await readJson(res, stremioManifest);
      expect(value.behaviorHints.configurationRequired).toBe(true);
      expect(db.getTable("accounts")).toEqual([]);
    },
  );
});

describe.each(JUNK_KEYS)("the junk key %j", (key) => {
  const path = (suffix: string) => `/${encodeURIComponent(key)}${suffix}`;

  it("is not found as a manifest and reaches no table", async () => {
    // A stored junk row must stay unreachable.
    seedLegacyAccount(key);
    const from = vi.spyOn(supabase, "from");

    const res = await app.request(path("/manifest.json"));

    expect(res.status).toBe(404);
    const value = await readJson(res, stremioManifest);
    expect(value.behaviorHints.configurationRequired).toBe(true);
    expect(from).not.toHaveBeenCalled();
    expect(db.getTable("accounts")).toHaveLength(1);
  });

  it("answers catalog, meta and stream requests empty, without a lookup", async () => {
    seedLegacyAccount(key);
    const from = vi.spyOn(supabase, "from");

    const answers = await Promise.all(
      [
        `/catalog/movie/wl-${LIST_ID}-movie.json`,
        `/meta/movie/${SHAWSHANK.id}.json`,
        `/stream/movie/${SHAWSHANK.id}.json`,
      ].map(async (suffix) => {
        const res = await app.request(path(suffix));
        return [res.status, await res.json()] as const;
      }),
    );

    expect(answers).toEqual([
      [200, { metas: [] }],
      [200, { meta: null }],
      [200, { streams: [], cacheMaxAge: 0 }],
    ]);
    expect(from).not.toHaveBeenCalled();
  });

  it("is refused by the configuration API", async () => {
    seedLegacyAccount(key);
    const from = vi.spyOn(supabase, "from");

    const res = await app.request(path("/config"));

    expect(res.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });
});
