// Recorded shapes (api.trakt.tv, 2026-10-06), trimmed.
export const clerks = {
  title: "Clerks III",
  year: 2022,
  ids: {
    trakt: 475091,
    slug: "clerks-iii-2022",
    imdb: "tt11128440",
    tmdb: 635891,
  },
};
export const halloween = {
  title: "Halloween Ends",
  year: 2022,
  ids: {
    trakt: 460030,
    slug: "halloween-ends-2022",
    imdb: "tt10665342",
    tmdb: 616820,
  },
};
export const mandalorian = {
  title: "The Mandalorian",
  year: 2019,
  ids: {
    trakt: 137178,
    slug: "the-mandalorian",
    imdb: "tt8111088",
    tmdb: 82856,
    tvdb: 361753,
  },
};
export const pitt = {
  title: "The Pitt",
  year: 2025,
  ids: {
    trakt: 232884,
    slug: "the-pitt",
    imdb: "tt31938062",
    tmdb: 250307,
    tvdb: 448176,
  },
};
export const noImdbShow = {
  title: "New Anime",
  year: 2026,
  ids: {
    trakt: 999001,
    slug: "new-anime",
    imdb: null,
    tmdb: 777001,
    tvdb: null,
  },
};

export function listed(
  type: "movie" | "show" | "season" | "episode",
  media: object,
  listedAt: string,
  rank: number,
): object {
  const base = { rank, id: rank * 10, listed_at: listedAt, notes: null, type };
  if (type === "movie") return { ...base, movie: media };
  if (type === "show") return { ...base, show: media };
  if (type === "season")
    return { ...base, show: media, season: { number: 1, ids: { trakt: 1 } } };
  return {
    ...base,
    show: media,
    episode: { season: 1, number: 2, ids: { trakt: 2 } },
  };
}
