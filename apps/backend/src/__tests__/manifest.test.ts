import type { StremioManifest } from "@stremlist/shared/stremio.types";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/supabase", async () => {
  return await import("./helpers/mock-supabase.js");
});
vi.mock("../services/list-cache", async () => {
  return await import("./helpers/mock-list-cache.js");
});
vi.mock("../providers/registry", async () => {
  return await import("./helpers/mock-registry.js");
});
vi.mock("../lib/resend", () => ({
  resend: { contacts: { create: vi.fn() } },
}));

import app from "../index.js";
import {
  LIST_IDS,
  seedAccount,
  seedConnection,
  seedLegacyAccount,
  seedList,
} from "./helpers/fixtures.js";
import { cache } from "./helpers/mock-list-cache.js";
import {
  fakeActions,
  fakeAdapter,
  resetProviders,
  useFakeProvider,
} from "./helpers/mock-registry.js";
import { db, resetRpc } from "./helpers/mock-supabase.js";

const IMDB_USER = "ur12345678";
const STREAM_RESOURCE = {
  name: "stream",
  types: ["movie", "series"],
  idPrefixes: ["tt"],
};

async function manifest(key: string): Promise<StremioManifest> {
  const res = await app.request(`/${key}/manifest.json`);
  expect(res.status).toBe(200);
  return (await res.json()) as StremioManifest;
}

function catalogIds(value: StremioManifest): string[] {
  return value.catalogs.map((catalog) => catalog.id);
}

beforeEach(() => {
  db.reset();
  resetRpc();
  cache.reset();
  resetProviders();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("private manifest", () => {
  it("has a stable ID that does not contain the Account ID", async () => {
    const account = seedAccount();
    seedList(account.id, { id: LIST_IDS[0], source_ref: IMDB_USER });

    const first = await manifest(account.id);
    const second = await manifest(account.id);

    expect(first.id).toMatch(/^com\.stremlist\.[0-9a-f]{16}$/);
    expect(first.id).toBe(second.id);
    expect(first.id).not.toContain(account.id);
    expect(first.id).not.toContain(account.id.slice(3));
    expect(JSON.stringify(first)).not.toContain(account.id);
    expect(first.behaviorHints).toEqual({
      configurable: true,
      configurationRequired: false,
    });
    expect(catalogIds(first)).toEqual([
      `wl-${LIST_IDS[0]}-movie`,
      `wl-${LIST_IDS[0]}-series`,
    ]);
  });

  it("gives two Accounts two different IDs", async () => {
    const [a, b] = [seedAccount(), seedAccount()];

    expect((await manifest(a.id)).id).not.toBe((await manifest(b.id)).id);
  });

  it("shows Connection lists", async () => {
    const account = seedAccount();
    seedConnection(account.id, "trakt");
    seedList(account.id, { id: LIST_IDS[0], source_ref: IMDB_USER });
    seedList(account.id, {
      id: LIST_IDS[1],
      provider: "trakt",
      source_ref: "me/watchlist",
      position: 1,
    });

    expect(catalogIds(await manifest(account.id))).toEqual([
      `wl-${LIST_IDS[0]}-movie`,
      `wl-${LIST_IDS[0]}-series`,
      `wl-${LIST_IDS[1]}-movie`,
      `wl-${LIST_IDS[1]}-series`,
    ]);
  });

  it("has no stream resource while Actions are off", async () => {
    useFakeProvider(fakeAdapter("trakt", { actions: fakeActions() }));
    const account = seedAccount({ action_providers: ["trakt"] });
    seedConnection(account.id, "trakt");

    expect((await manifest(account.id)).resources).toEqual([
      "catalog",
      { name: "meta", types: ["movie"], idPrefixes: ["tt"] },
    ]);
  });

  it("adds the stream resource when Actions are on with a connected Provider that acts", async () => {
    useFakeProvider(fakeAdapter("trakt", { actions: fakeActions() }));
    const account = seedAccount({
      actions_enabled: true,
      action_providers: ["trakt"],
    });
    seedConnection(account.id, "trakt");

    expect((await manifest(account.id)).resources).toEqual([
      "catalog",
      { name: "meta", types: ["movie"], idPrefixes: ["tt"] },
      STREAM_RESOURCE,
    ]);
  });

  it.each([
    ["the Provider has no Connection", false, true, false],
    ["the Provider has no Actions", true, false, false],
    ["the Provider is turned off", true, true, true],
  ])(
    "has no stream resource when %s",
    async (_label, connected, withActions, disabled) => {
      useFakeProvider(
        fakeAdapter("trakt", withActions ? { actions: fakeActions() } : {}),
      );
      if (disabled) process.env.DISABLED_PROVIDERS = "trakt";
      const account = seedAccount({
        actions_enabled: true,
        action_providers: ["trakt"],
      });
      if (connected) seedConnection(account.id, "trakt");

      expect((await manifest(account.id)).resources).not.toContainEqual(
        STREAM_RESOURCE,
      );
    },
  );
});

describe("legacy manifest", () => {
  it("keeps the historic ID and hides Connection lists", async () => {
    const legacy = seedLegacyAccount(IMDB_USER, { rpdb_api_key: "rpdb" });
    seedConnection(legacy.id, "trakt");
    seedList(legacy.id, { id: LIST_IDS[0], source_ref: IMDB_USER });
    seedList(legacy.id, {
      id: LIST_IDS[1],
      provider: "trakt",
      source_ref: "me/watchlist",
      position: 1,
    });
    seedList(legacy.id, {
      id: LIST_IDS[2],
      provider: "simkl",
      source_ref: "me/plantowatch",
      position: 2,
    });

    const value = await manifest(IMDB_USER);

    expect(value.id).toBe(`com.stremlist.${IMDB_USER}`);
    expect(catalogIds(value)).toEqual([
      `wl-${LIST_IDS[0]}-movie`,
      `wl-${LIST_IDS[0]}-series`,
    ]);
    expect(value.config?.[0]).toMatchObject({
      key: "rpdbApiKey",
      default: "rpdb",
    });
    expect(JSON.stringify(value)).not.toContain(legacy.id);
  });

  it("never has a stream resource, even with Actions on", async () => {
    useFakeProvider(fakeAdapter("trakt", { actions: fakeActions() }));
    const legacy = seedLegacyAccount(IMDB_USER, {
      actions_enabled: true,
      action_providers: ["trakt"],
    });
    seedConnection(legacy.id, "trakt");

    expect((await manifest(IMDB_USER)).resources).not.toContainEqual(
      STREAM_RESOURCE,
    );
  });

  it("creates a legacy Account for an old install that never saved", async () => {
    const value = await manifest(IMDB_USER);

    const [account] = db.getTable("accounts");
    expect(account).toMatchObject({ legacy_imdb_user_id: IMDB_USER });
    const [list] = db.getTable("lists");
    expect(list).toMatchObject({
      account_id: account.id,
      provider: "imdb",
      source_ref: IMDB_USER,
    });
    expect(catalogIds(value)).toEqual([
      `wl-${String(list.id)}-movie`,
      `wl-${String(list.id)}-series`,
    ]);
  });

  it("asks for configuration when the internal ID of a legacy Account is used", async () => {
    const legacy = seedLegacyAccount(IMDB_USER);
    seedList(legacy.id, { id: LIST_IDS[0], source_ref: IMDB_USER });

    const value = await manifest(legacy.id);

    expect(value.behaviorHints.configurationRequired).toBe(true);
    expect(JSON.stringify(value)).not.toContain(LIST_IDS[0]);
  });
});

describe("other manifests", () => {
  it("asks for configuration for an unknown Account ID", async () => {
    const value = await manifest("sl_0000000000000000000000");

    expect(value.behaviorHints.configurationRequired).toBe(true);
    expect(db.getTable("accounts")).toEqual([]);
  });

  it("refuses a key that is not an Addon URL key", async () => {
    const res = await app.request("/ls123456789/manifest.json");

    expect(res.status).toBe(400);
    expect(db.getTable("accounts")).toEqual([]);
  });
});
