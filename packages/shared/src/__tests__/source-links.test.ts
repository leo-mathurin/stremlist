import type { ParsedSourceLink } from "../providers";
import {
  describeSourceRef,
  parseSourceLink,
  sourceRequiresConnection,
} from "../providers";
import { describe, expect, it } from "vitest";

const JUSTWATCH_ID = "tl-us-0f1e2d3c-4b5a-4968-8776-655443322110";

function parsed(
  provider: ParsedSourceLink["provider"],
  ref: string,
  kind: ParsedSourceLink["kind"],
  extra: Partial<ParsedSourceLink> = {},
): ParsedSourceLink {
  return { provider, sourceRef: ref, kind, ...extra };
}

describe("parseSourceLink: IMDb", () => {
  it.each([
    ["ur12345678", "ur12345678"],
    ["  UR12345678  ", "ur12345678"],
    ["https://www.imdb.com/user/ur12345678/watchlist", "ur12345678"],
    [
      "https://www.imdb.com/user/ur12345678/watchlist/?ref_=nv_usr_wl_all_0",
      "ur12345678",
    ],
    ["imdb.com/user/ur12345678/watchlist", "ur12345678"],
    ["https://m.imdb.com/user/ur12345678/watchlist", "ur12345678"],
    ["https://www.imdb.com/user/ur12345678/", "ur12345678"],
  ])("reads the watchlist of %j", (input, ref) => {
    expect(parseSourceLink(input)).toEqual(parsed("imdb", ref, "watchlist"));
  });

  it.each([
    ["p.leo123", "p.leo123"],
    ["https://www.imdb.com/user/p.leo123/watchlist", "p.leo123"],
    ["https://www.imdb.com/user/p.leo123/watchlist?ref_=x", "p.leo123"],
  ])("keeps the p. handle of %j for the adapter to resolve", (input, ref) => {
    expect(parseSourceLink(input)).toEqual(parsed("imdb", ref, "watchlist"));
  });

  it.each([
    ["ls123456789", "ls123456789"],
    ["https://www.imdb.com/list/ls123456789/", "ls123456789"],
    ["https://www.imdb.com/list/LS123456789/?sort=list_order", "ls123456789"],
  ])("reads the list %j", (input, ref) => {
    expect(parseSourceLink(input)).toEqual(parsed("imdb", ref, "list"));
  });

  it.each(["imdb:most-popular-movies", "imdb:top-rated-tv", "imdb:box-office"])(
    "reads the built-in chart %j",
    (input) => {
      expect(parseSourceLink(input)).toEqual(parsed("imdb", input, "chart"));
    },
  );

  it.each([
    "imdb:not-a-chart",
    "https://www.imdb.com/title/tt0111161/",
    "tt0111161",
    "https://example.com/user/ur12345678/watchlist",
    "https://www.imdb.com/chart/top/",
  ])("does not read %j", (input) => {
    expect(parseSourceLink(input)).toBeNull();
  });
});

describe("parseSourceLink: Trakt", () => {
  it("reads a user's watchlist, with the user name lowercased", () => {
    expect(parseSourceLink("https://trakt.tv/users/LeoM/watchlist")).toEqual(
      parsed("trakt", "users/leom/watchlist", "watchlist", {
        suggestedTitle: "LeoM's watchlist",
      }),
    );
  });

  it("reads an official list by its slug", () => {
    expect(
      parseSourceLink(
        "https://trakt.tv/lists/official/the-dark-knight-collection",
      ),
    ).toEqual(parsed("trakt", "lists/the-dark-knight-collection", "list"));
  });

  it.each([
    "https://trakt.tv/users/leo/lists/sci-fi-picks",
    "trakt.tv/users/leo/lists/sci-fi-picks?sort=rank,asc",
    "https://app.trakt.tv/users/LEO/lists/Sci-Fi-Picks",
  ])("reads the user list %j", (input) => {
    expect(parseSourceLink(input)).toEqual(
      parsed("trakt", "users/leo/lists/sci-fi-picks", "list"),
    );
  });

  it.each([
    ["https://trakt.tv/lists/2142753", "lists/2142753"],
    ["https://trakt.tv/lists/Star-Wars-Saga", "lists/star-wars-saga"],
  ])("reads the shared list %j", (input, ref) => {
    expect(parseSourceLink(input)).toEqual(parsed("trakt", ref, "list"));
  });

  it.each([
    "https://trakt.tv/users/leo",
    "https://trakt.tv/movies/inception-2010",
  ])("does not read %j", (input) => {
    expect(parseSourceLink(input)).toBeNull();
  });
});

describe("parseSourceLink: MDBList", () => {
  it("reads a list, which always needs a Connection", () => {
    // The backend resolves user and slug to a list ID, so case is kept.
    expect(
      parseSourceLink("https://mdblist.com/lists/LeoM/Top-Movies-2026"),
    ).toEqual(parsed("mdblist", "lists/LeoM/Top-Movies-2026", "list"));
    expect(
      sourceRequiresConnection("mdblist", "lists/LeoM/Top-Movies-2026"),
    ).toBe(true);
  });

  it("does not read a profile page", () => {
    expect(parseSourceLink("https://mdblist.com/lists/leom")).toBeNull();
  });
});

describe("parseSourceLink: JustWatch", () => {
  it.each([
    `https://www.justwatch.com/us/lists/my-lists?id=${JUSTWATCH_ID}`,
    `https://www.justwatch.com/shared?id=${JUSTWATCH_ID}`,
    `https://www.justwatch.com/fr/lists/${JUSTWATCH_ID}`,
    JUSTWATCH_ID,
    JUSTWATCH_ID.toUpperCase(),
  ])("reads the list in %j", (input) => {
    expect(parseSourceLink(input)).toEqual(
      parsed("justwatch", JUSTWATCH_ID, "list"),
    );
  });

  it.each([
    "https://www.justwatch.com/us/watchlist",
    "https://example.com/shared?id=" + JUSTWATCH_ID,
    "tl-us-not-a-uuid",
  ])("does not read %j", (input) => {
    expect(parseSourceLink(input)).toBeNull();
  });
});

describe("parseSourceLink: SensCritique", () => {
  it.each([
    "https://www.senscritique.com/LeoM",
    "https://www.senscritique.com/LeoM/collection?action=WISH",
    "senscritique.com/LeoM/collection",
  ])("reads the wishlist of the profile in %j", (input) => {
    expect(parseSourceLink(input)).toEqual(
      parsed("senscritique", "users/LeoM/wishes", "watchlist", {
        suggestedTitle: "LeoM's wishlist",
      }),
    );
  });

  it("reads a list by its ID", () => {
    expect(
      parseSourceLink(
        "https://www.senscritique.com/liste/films_cultes/3171742",
      ),
    ).toEqual(parsed("senscritique", "lists/3171742", "list"));
  });

  it.each([
    "https://www.senscritique.com/",
    "https://www.senscritique.com/film/inception/450170",
    "https://www.senscritique.com/serie/breaking_bad/507411",
    "https://www.senscritique.com/liste/films_cultes",
  ])("does not read %j", (input) => {
    expect(parseSourceLink(input)).toBeNull();
  });
});

describe("parseSourceLink: Letterboxd", () => {
  it("reads a watchlist", () => {
    expect(parseSourceLink("https://letterboxd.com/LeoM/watchlist/")).toEqual(
      parsed("letterboxd", "users/leom/watchlist", "watchlist"),
    );
  });

  it("reads a list", () => {
    expect(
      parseSourceLink("https://letterboxd.com/leom/list/Best-Of-2026/"),
    ).toEqual(parsed("letterboxd", "users/leom/lists/best-of-2026", "list"));
  });

  it("recognizes short links so the configure page can say coming soon", () => {
    expect(parseSourceLink("https://boxd.it/abcd")).toMatchObject({
      provider: "letterboxd",
    });
  });
});

describe("parseSourceLink: junk", () => {
  it.each([
    "",
    "   ",
    "hello",
    "not a link",
    "https://",
    "https://example.com/list/ls123456789",
    "https://netflix.com/browse/my-list",
    "javascript:alert(1)",
  ])("returns null for %j", (input) => {
    expect(parseSourceLink(input)).toBeNull();
  });
});

describe("sourceRequiresConnection", () => {
  it.each([
    ["trakt", "me/watchlist", true],
    ["trakt", "users/leo/watchlist", false],
    ["trakt", "trending", false],
    ["simkl", "me/plantowatch", true],
    ["mdblist", "lists/leo/top", true],
    ["imdb", "ur12345678", false],
    ["justwatch", JUSTWATCH_ID, false],
  ] as const)("%s %s → %s", (provider, ref, expected) => {
    expect(sourceRequiresConnection(provider, ref)).toBe(expected);
  });
});

describe("describeSourceRef kind", () => {
  it.each([
    "https://www.imdb.com/user/ur12345678/watchlist",
    "https://www.imdb.com/list/ls012345678/",
    "p.leom",
    "imdb:top-rated-movies",
    "https://trakt.tv/users/LeoM/watchlist",
    "https://trakt.tv/users/me/watchlist",
    "https://trakt.tv/users/LeoM/lists/horror",
    "https://trakt.tv/lists/official/star-wars",
    "https://trakt.tv/movies/trending",
    "https://mdblist.com/lists/LeoM/top-movies",
    "https://mdblist.com/watchlist/LeoM",
    `https://www.justwatch.com/us/lists/${JUSTWATCH_ID}`,
    "https://www.senscritique.com/Sergent_Pepper/collection?action=WISH",
    "https://www.senscritique.com/liste/films/369869",
    "https://letterboxd.com/leom/watchlist/",
    "https://letterboxd.com/leom/list/best-of-2026/",
  ])("gives the kind that the link parser found for %s", (link) => {
    const parsed = parseSourceLink(link);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(describeSourceRef(parsed.provider, parsed.sourceRef).kind).toBe(
      parsed.kind,
    );
  });

  it("knows the Source lists of the source tables", () => {
    expect(describeSourceRef("simkl", "me/completed").kind).toBe("status");
    expect(describeSourceRef("trakt", "me/up-next").kind).toBe("up_next");
  });
});

describe("describeSourceRef", () => {
  it("describes a SensCritique wishlist as a watchlist", () => {
    expect(describeSourceRef("senscritique", "users/leom/wishes")).toEqual({
      kind: "watchlist",
      detail: "leom",
      url: "https://www.senscritique.com/leom/collection?action=WISH",
      title: "leom's wishlist",
    });
  });

  it("names a fixed Source list after its Provider and label", () => {
    expect(describeSourceRef("trakt", "trending")).toEqual({
      kind: "chart",
      detail: null,
      url: "https://trakt.tv/movies/trending",
      title: "Trakt Trending",
    });
    expect(describeSourceRef("simkl", "me/plantowatch")).toEqual({
      kind: "watchlist",
      detail: "Your account",
      url: null,
      title: "Simkl Plan to watch",
    });
  });

  it("names an IMDb chart after the chart", () => {
    expect(describeSourceRef("imdb", "imdb:top-rated-movies")).toMatchObject({
      kind: "chart",
      title: "Top 250 Movies",
    });
  });

  it("keeps an unknown reference as a list", () => {
    expect(describeSourceRef("trakt", "me/lists/42")).toEqual({
      kind: "list",
      detail: "me/lists/42",
      url: null,
    });
  });
});
