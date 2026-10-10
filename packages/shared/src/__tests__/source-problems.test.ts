import { PROVIDER_IDS } from "../providers";
import {
  SOURCE_PROBLEM_REASONS,
  sourceProblemCopy,
  storedSourceNoun,
} from "../source-problems";
import { describe, expect, it } from "vitest";

describe("storedSourceNoun", () => {
  it.each([
    ["imdb", "ur12345678", "watchlist"],
    ["imdb", "ls012345678", "list"],
    ["imdb", "imdb:top-250-movies", "list"],
    ["trakt", "users/sean/watchlist", "watchlist"],
    ["trakt", "me/watchlist", "watchlist"],
    ["trakt", "users/sean/lists/horror", "list"],
    ["simkl", "me/plantowatch", "watchlist"],
    ["simkl", "me/completed", "list"],
    ["mdblist", "me/watchlist", "watchlist"],
    ["senscritique", "users/leom/wishes", "watchlist"],
    ["senscritique", "lists/369869", "list"],
    ["justwatch", "tl-us-12653", "list"],
    ["letterboxd", "users/leom/watchlist", "watchlist"],
  ] as const)("%s %s is a %s", (provider, ref, noun) => {
    expect(storedSourceNoun(provider, ref)).toBe(noun);
  });
});

describe("sourceProblemCopy", () => {
  it("names the Source list with the given noun", () => {
    expect(sourceProblemCopy("imdb", "private", "watchlist").title).toBe(
      "This IMDb watchlist is private",
    );
    expect(sourceProblemCopy("imdb", "private", "list").title).toBe(
      "This IMDb list is private",
    );
  });

  it("has copy for every Provider and reason, without em dashes", () => {
    for (const provider of PROVIDER_IDS) {
      for (const reason of SOURCE_PROBLEM_REASONS) {
        const { title, fix } = sourceProblemCopy(provider, reason);
        expect(title).not.toBe("");
        expect(fix).not.toBe("");
        expect(`${title} ${fix}`).not.toContain("—");
        expect(title).not.toMatch(/\.$/);
      }
    }
  });
});
