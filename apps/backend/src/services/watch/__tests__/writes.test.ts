import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/supabase", () => ({ supabase: {} }));
vi.mock("../../../providers/registry", () => ({
  isProviderEnabled: (provider: string) => provider !== "mdblist",
}));

import type { ClaimedWrite } from "../writes";
import { capPerDestination } from "../writes";

let next = 0;
function write(account: string, provider: string): ClaimedWrite {
  next += 1;
  return {
    id: next,
    account_id: account,
    provider,
    imdb_id: `tt${String(next).padStart(7, "0")}`,
    item_type: "movie",
    season: 0,
    episode: 0,
    watched_at: "2026-11-12T10:00:00.000Z",
    attempts: 0,
    first_failed_at: null,
    uncertain: false,
  };
}

describe("the sends of one claim", () => {
  it("keep 20 a Destination and make the rest wait a minute per 20", () => {
    const bulk = Array.from({ length: 45 }, () => [write("a", "trakt")]);
    const other = [write("b", "trakt")];
    const { kept, later } = capPerDestination([...bulk, other]);
    expect(kept).toHaveLength(21);
    expect(kept.at(-1)).toBe(other);
    expect(later.get(1)).toHaveLength(20);
    expect(later.get(2)).toHaveLength(5);
  });

  it("send nothing to a Provider turned off: its rows wait 15 minutes", () => {
    const off = [write("a", "mdblist")];
    const { kept, later } = capPerDestination([off]);
    expect(kept).toEqual([]);
    expect(later.get(15)).toEqual([off[0].id]);
  });
});
