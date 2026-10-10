import type { Tables } from "@stremlist/shared/database.types";
import { describe, expect, it } from "vitest";
import { listRowCacheKeys, mapList } from "../list-rows";
import { sourceCaches } from "../merged-lists";

function row(overrides: Partial<Tables<"lists">>): Tables<"lists"> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    account_id: "sl_0000000000000000000000",
    provider: "imdb",
    source_ref: "ur12345678",
    catalog_title: "",
    sort_option: "added_at-asc",
    display_mode: "split",
    position: 0,
    catalog_settings: {},
    merged_sources: [],
    source_label: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

describe("listRowCacheKeys", () => {
  it("keeps the List ID for a List with one Source list", () => {
    expect(listRowCacheKeys([row({})])).toEqual([
      "11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("gives every Source list of a merged List, not the List ID", () => {
    const merged = row({
      id: "22222222-2222-4222-8222-222222222222",
      merged_sources: [
        { provider: "trakt", source_ref: "users/leo/watchlist" },
      ],
    });
    const list = mapList(merged);
    if (!list) throw new Error("expected a List");

    const keys = listRowCacheKeys([merged]);

    expect(keys).toEqual(sourceCaches(list).map(({ cacheKey }) => cacheKey));
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).toMatch(
        /^22222222-2222-4222-8222-222222222222\/sources\/[0-9a-f]{16}$/u,
      );
    }
  });

  it("keeps the List ID of a row whose Provider is unknown", () => {
    expect(
      listRowCacheKeys([
        row({ id: "33333333-3333-4333-8333-333333333333", provider: "gone" }),
      ]),
    ).toEqual(["33333333-3333-4333-8333-333333333333"]);
  });
});
