import { CHART_REGISTRY } from "../imdb-charts";
import type { ProviderId } from "../providers";
import {
  CONNECTION_SOURCES,
  describeSourceRef,
  listTypeOf,
  listTypes,
  PROVIDER_IDS,
  PUBLIC_SOURCES,
} from "../providers";
import { describe, expect, it } from "vite-plus/test";

describe("listTypeOf", () => {
  it.each<[ProviderId, string, string]>([
    ["imdb", "imdb:top-rated-movies", "imdb:chart/top-rated-movies"],
    ["imdb", "ur12345678", "imdb:ur/watchlist"],
    ["imdb", "p.alice", "imdb:ur/watchlist"],
    ["imdb", "ls123456789", "imdb:ls/list"],
    ["imdb", "ur12345678/ratings", "imdb:ur/ratings"],
    ["trakt", "trending", "trakt:trending"],
    ["trakt", "me/history", "trakt:me/history"],
    ["trakt", "users/alice/watchlist", "trakt:users/{user}/watchlist"],
    ["trakt", "users/alice/history", "trakt:users/{user}/history"],
    ["trakt", "users/alice/ratings", "trakt:users/{user}/ratings"],
    ["trakt", "me/ratings", "trakt:me/ratings"],
    ["trakt", "boxoffice", "trakt:boxoffice"],
    ["trakt", "users/alice/lists/sci-fi", "trakt:users/{user}/lists/{list}"],
    ["trakt", "lists/marvel", "trakt:lists/{list}"],
    ["trakt", "smart-lists/silos", "trakt:smart-lists/{slug}"],
    ["trakt", "me/smart-lists/silos", "trakt:me/smart-lists/{slug}"],
    ["trakt", "me/lists/weekend", "trakt:me/lists/{list}"],
    ["simkl", "me/plantowatch", "simkl:me/plantowatch"],
    ["simkl", "me/lists/12", "simkl:me/lists/{id}"],
    ["simkl", "trending/tv/today", "simkl:trending/tv/today"],
    [
      "simkl",
      "trending/anime/genre/isekai",
      "simkl:trending/{type}/genre/{slug}",
    ],
    ["mdblist", "lists/2194", "mdblist:lists/{id}"],
    ["mdblist", "me/external/77", "mdblist:me/external/{id}"],
    ["justwatch", "tl-us-1", "justwatch:{list}"],
    ["senscritique", "users/alice/wishes", "senscritique:users/{user}/wishes"],
    [
      "letterboxd",
      "users/alice/films/rated/4-5",
      "letterboxd:users/{user}/films/rated/{range}",
    ],
    ["letterboxd", "share/sealed-token", "letterboxd:share/{token}"],
    ["trakt", "something/else", "trakt:other"],
  ])("maps %s %s to %s", (provider, ref, type) => {
    expect(listTypeOf(provider, ref)).toBe(type);
  });

  it("keeps the description of the account lists that it now names", () => {
    expect(describeSourceRef("mdblist", "me/lists/12")).toEqual({
      kind: "list",
      detail: "me/lists/12",
      url: null,
    });
  });
});

describe("listTypes", () => {
  it("names every chart, fixed Source list and stored reference form once", () => {
    const types = listTypes();
    expect(new Set(types).size).toBe(types.length);
    for (const chart of CHART_REGISTRY)
      expect(types).toContain(listTypeOf("imdb", chart.id));
    for (const provider of PROVIDER_IDS)
      for (const source of [
        ...(CONNECTION_SOURCES[provider] ?? []),
        ...(PUBLIC_SOURCES[provider] ?? []),
      ])
        expect(types).toContain(listTypeOf(provider, source.ref));
    expect(types.filter((type) => type.endsWith(":other"))).toEqual([]);
  });
});
