import { describe, it, expect } from "vite-plus/test";
import { fetchWatchlist } from "../imdb-scraper.js";

const NOT_FOUND_ERROR = /Could not find an IMDb watchlist/;

describe("live: real IMDb GraphQL API", () => {
  it.each(["ur195879360", "ur100660343"])(
    "fetches a public watchlist (%s)",
    async (userId) => {
      const { metas } = await fetchWatchlist(userId);

      expect(metas.length).toBeGreaterThan(0);
      for (const meta of metas) {
        expect(meta.id).toMatch(/^tt\d+$/);
        expect(meta.type).toMatch(/^(movie|series)$/);
        expect(meta.name).toBeTruthy();
      }
    },
  );

  it("throws for a private watchlist (ur198342247)", async () => {
    await expect(fetchWatchlist("ur198342247")).rejects.toThrow(/private/i);
  });

  it("throws for an invalid IMDb user ID (ur1198342247)", async () => {
    await expect(fetchWatchlist("ur1198342247")).rejects.toThrow(
      NOT_FOUND_ERROR,
    );
  });

  it("returns empty metas for an empty watchlist (ur198654279)", async () => {
    expect((await fetchWatchlist("ur198654279")).metas).toEqual([]);
  });
});
