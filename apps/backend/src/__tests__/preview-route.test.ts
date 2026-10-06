import type { CatalogPreviewResponse } from "@stremlist/shared/catalog-preview";
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
vi.mock("../lib/r2", async () => {
  return await import("./helpers/mock-r2.js");
});
vi.mock("../lib/resend", () => ({
  resend: { contacts: { create: vi.fn() } },
}));

import app from "../index.js";
import { resetPreviewReadings } from "../services/list-preview";
import {
  movie,
  seedAccount,
  seedConnection,
  seedLegacyAccount,
} from "./helpers/fixtures.js";
import {
  fakeAdapter,
  resetProviders,
  useFakeProvider,
} from "./helpers/mock-registry.js";
import { db } from "./helpers/mock-supabase.js";

const TITLE = movie("tt0111161", { name: "The Shawshank Redemption" });

function preview(body: Record<string, unknown>) {
  return app.request("/lists/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sortOption: "added_at-asc", ...body }),
  });
}

function traktReader() {
  const fetchSource = vi.fn(() =>
    Promise.resolve({
      entries: [{ imdbId: TITLE.id, type: "movie" as const, meta: TITLE }],
    }),
  );
  useFakeProvider(fakeAdapter("trakt", { fetchSource }));
  return fetchSource;
}

beforeEach(() => {
  db.reset();
  resetProviders();
  resetPreviewReadings();
  vi.restoreAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("POST /lists/preview", () => {
  it("previews a public Source list without an Account", async () => {
    const fetchSource = traktReader();

    const res = await preview({
      provider: "trakt",
      sourceRef: "users/someone/watchlist",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogPreviewResponse;
    expect(body).toMatchObject({
      ok: true,
      titleCount: 1,
      catalogs: [
        {
          type: "movie",
          preset: null,
          total: 1,
          titles: [{ id: TITLE.id, name: TITLE.name }],
        },
        { type: "series", preset: null, total: 0, titles: [] },
      ],
      unresolved: { count: 0, notCheckedYet: 0, entries: [] },
    });
    expect(fetchSource).toHaveBeenCalledWith("users/someone/watchlist", {
      connection: null,
    });
  });

  it("reads through the Connection of a private Account", async () => {
    const fetchSource = traktReader();
    const account = seedAccount();
    seedConnection(account.id, "trakt");

    const res = await preview({
      accountKey: account.id,
      provider: "trakt",
      sourceRef: "me/history",
    });

    expect(await res.json()).toMatchObject({ ok: true, titleCount: 1 });
    expect(fetchSource).toHaveBeenCalledWith("me/history", {
      connection: expect.objectContaining({ provider: "trakt" }) as unknown,
    });
  });

  it("never reads through a Connection for a Legacy alias", async () => {
    const fetchSource = traktReader();
    const account = seedLegacyAccount("ur12345678");
    seedConnection(account.id, "trakt");

    const res = await preview({
      accountKey: "ur12345678",
      provider: "trakt",
      sourceRef: "me/history",
    });

    expect(await res.json()).toEqual({
      ok: false,
      reason: "needs_connection",
    });
    expect(fetchSource).not.toHaveBeenCalled();
  });

  it("treats an unknown Account key like a new setup", async () => {
    const fetchSource = traktReader();

    const res = await preview({
      accountKey: "sl_0000000000000000000000",
      provider: "trakt",
      sourceRef: "users/someone/watchlist",
    });

    expect(await res.json()).toMatchObject({ ok: true });
    expect(fetchSource).toHaveBeenCalledWith("users/someone/watchlist", {
      connection: null,
    });
  });

  it("refuses a malformed request", async () => {
    const unknownProvider = await preview({
      provider: "netflix",
      sourceRef: "x",
    });
    const badSort = await preview({
      provider: "trakt",
      sourceRef: "users/someone/watchlist",
      sortOption: "loudness-desc",
    });
    const badKey = await preview({
      accountKey: "not-a-key",
      provider: "trakt",
      sourceRef: "users/someone/watchlist",
    });

    expect(unknownProvider.status).toBe(400);
    expect(badSort.status).toBe(400);
    expect(badKey.status).toBe(400);
  });
});
