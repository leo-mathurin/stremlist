import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  seedAccount,
  seedLegacyAccount,
  seedList,
} from "../../__tests__/helpers/fixtures";
import { cache } from "../../__tests__/helpers/mock-list-cache";
import { db, resetRpc } from "../../__tests__/helpers/mock-supabase";
import {
  ensureLegacyAccount,
  getAccountLists,
  resolveAccountKey,
} from "../accounts";

vi.mock("../../lib/supabase", async () => {
  return await import("../../__tests__/helpers/mock-supabase");
});
vi.mock("../list-cache", async () => {
  return await import("../../__tests__/helpers/mock-list-cache");
});

const IMDB_USER = "ur12345678";

beforeEach(() => {
  db.reset();
  resetRpc();
  cache.reset();
});

describe("resolveAccountKey", () => {
  it("opens an Account through its private ID", async () => {
    const account = seedAccount({ rpdb_api_key: "rpdb" });

    expect(await resolveAccountKey(account.id)).toMatchObject({
      via: "private",
      account: { id: account.id, legacyImdbUserId: null, rpdbApiKey: "rpdb" },
    });
  });

  it("opens an Account through its Legacy alias", async () => {
    const account = seedLegacyAccount(IMDB_USER);

    expect(await resolveAccountKey(IMDB_USER)).toMatchObject({
      via: "legacy",
      account: { id: account.id, legacyImdbUserId: IMDB_USER },
    });
  });

  it("never opens an Account with a Legacy alias through its private ID", async () => {
    // The ID of a legacy Account is not a secret that its owner received:
    // the Account stays reachable only through the alias.
    const account = seedLegacyAccount(IMDB_USER);

    await expect(resolveAccountKey(account.id)).resolves.toBeNull();
  });

  it.each([
    "sl_0000000000000000000000",
    "ur99999999",
    "sl_short",
    "ls123456789",
    "p.leo123",
    "",
  ])("returns null for %j", async (key) => {
    seedAccount();
    seedLegacyAccount(IMDB_USER);
    await expect(resolveAccountKey(key)).resolves.toBeNull();
  });

  it("maps Action settings and drops unknown Providers", async () => {
    const account = seedAccount({
      actions_enabled: true,
      action_providers: ["trakt", "netflix", "simkl"],
    });

    expect((await resolveAccountKey(account.id))?.account).toMatchObject({
      actionsEnabled: true,
      actionProviders: ["trakt", "simkl"],
    });
  });
});

describe("ensureLegacyAccount", () => {
  it("creates a legacy Account whose only List is the IMDb watchlist", async () => {
    const access = await ensureLegacyAccount(IMDB_USER);

    expect(access.via).toBe("legacy");
    expect(access.account.id).toMatch(/^sl_[0-9A-Za-z]{22}$/);
    expect(access.account.legacyImdbUserId).toBe(IMDB_USER);
    expect(await getAccountLists(access.account.id)).toEqual([
      expect.objectContaining({
        provider: "imdb",
        sourceRef: IMDB_USER,
        catalogTitle: "",
        sortOption: "added_at-asc",
        displayMode: "split",
        position: 0,
      }),
    ]);
  });

  it("is idempotent and reactivates an inactive Account", async () => {
    const first = await ensureLegacyAccount(IMDB_USER);
    db.getTable("accounts")[0].is_active = false;

    const second = await ensureLegacyAccount(IMDB_USER);

    expect(second.account.id).toBe(first.account.id);
    expect(db.getTable("accounts")).toHaveLength(1);
    expect(db.getTable("accounts")[0].is_active).toBe(true);
    expect(db.getTable("lists")).toHaveLength(1);
  });

  it("does not add a second watchlist to an existing legacy Account", async () => {
    const account = seedLegacyAccount(IMDB_USER);
    seedList(account.id, { source_ref: "ls123456789" });

    await ensureLegacyAccount(IMDB_USER);

    expect(
      (await getAccountLists(account.id)).map((list) => list.sourceRef),
    ).toEqual(["ls123456789"]);
  });
});
