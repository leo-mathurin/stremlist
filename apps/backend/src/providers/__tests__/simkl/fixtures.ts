// Fixtures (shapes from api.simkl.org, 2026-10)

export function activities(overrides: {
  all: string;
  shows?: Record<string, string>;
  movies?: Record<string, string>;
  lists?: string;
}) {
  const base = "2026-09-01T00:00:00Z";
  return {
    all: overrides.all,
    settings: { all: base },
    tv_shows: {
      all: base,
      watching: base,
      plantowatch: base,
      hold: base,
      completed: base,
      dropped: base,
      rated_at: base,
      playback: base,
      removed_from_list: base,
      ...overrides.shows,
    },
    anime: {
      all: base,
      watching: base,
      plantowatch: base,
      hold: base,
      completed: base,
      dropped: base,
      rated_at: base,
      playback: base,
      removed_from_list: base,
    },
    movies: {
      all: base,
      plantowatch: base,
      completed: base,
      dropped: base,
      rated_at: base,
      playback: base,
      removed_from_list: base,
      ...overrides.movies,
    },
    custom_lists: {
      lists: {
        all: overrides.lists ?? "2026-09-21T20:53:09Z",
        regular: base,
        favorites: base,
        recommendations: base,
        auto: base,
      },
    },
  };
}

export const SHOWS = {
  shows: [
    {
      added_to_watchlist_at: "2018-02-24T23:55:13Z",
      last_watched_at: null,
      user_rated_at: null,
      user_rating: null,
      status: "plantowatch",
      last_watched: null,
      next_to_watch: "S01E01",
      watched_episodes_count: 0,
      total_episodes_count: 178,
      not_aired_episodes_count: 0,
      show: {
        title: "Charmed",
        poster: "24/24273cee77f9d9f",
        year: 1998,
        ids: {
          simkl: 297,
          slug: "charmed",
          imdb: "tt0158552",
          tvdb: "70626",
          tmdb: "1981",
        },
      },
    },
    {
      added_to_watchlist_at: "2026-05-15T00:13:18Z",
      last_watched_at: "2026-05-15T00:13:18Z",
      user_rated_at: "2026-05-16T14:20:16Z",
      user_rating: 9,
      status: "completed",
      watched_episodes_count: 73,
      show: {
        title: "Game of Thrones",
        year: 2011,
        ids: {
          simkl: 17465,
          slug: "game-of-thrones",
          imdb: "tt0944947",
          tmdb: "1399",
        },
      },
      seasons: [
        {
          number: 1,
          episodes: [
            { number: 1, watched_at: "2026-05-15T00:13:18Z" },
            { number: 2, watched_at: "2026-05-15T00:13:18Z" },
          ],
        },
      ],
    },
    {
      added_to_watchlist_at: "2026-05-15T00:35:15Z",
      last_watched_at: "2026-05-15T00:35:15Z",
      user_rating: null,
      status: "watching",
      watched_episodes_count: 1,
      show: {
        title: "The Walking Dead",
        year: 2010,
        ids: { simkl: 2090, slug: "the-walking-dead", imdb: "tt1520211" },
      },
      seasons: [{ number: 1, episodes: [{ number: 2 }] }],
    },
  ],
};

export const MOVIES = {
  movies: [
    {
      added_to_watchlist_at: "2026-05-14T06:49:56Z",
      last_watched_at: null,
      user_rating: null,
      status: "plantowatch",
      watched_episodes_count: 0,
      movie: {
        title: "Pulp Fiction",
        year: 1994,
        ids: { simkl: 54130, slug: "pulp-fiction", imdb: "tt0110912" },
      },
    },
    {
      added_to_watchlist_at: "2026-04-10T20:13:02Z",
      last_watched_at: "1994-09-01T16:00:00Z",
      user_rating: 10,
      status: "completed",
      watched_episodes_count: 0,
      movie: {
        title: "The Godfather",
        year: 1972,
        ids: {
          simkl: 53434,
          slug: "the-godfather",
          imdb: "tt0068646",
          tmdb: "238",
        },
      },
    },
    {
      // Legacy entry without an add time.
      added_to_watchlist_at: null,
      last_watched_at: null,
      user_rating: null,
      status: "plantowatch",
      movie: {
        title: "Old Movie",
        year: 1950,
        ids: { simkl: 999, slug: "old-movie", imdb: "tt0000999" },
      },
    },
  ],
};

export const ANIME = {
  anime: [
    {
      added_to_watchlist_at: "2026-05-15T00:13:09Z",
      last_watched_at: "2026-05-15T00:13:09Z",
      user_rating: null,
      status: "completed",
      watched_episodes_count: 26,
      anime_type: "tv",
      show: {
        title: "Cowboy Bebop",
        year: 1998,
        ids: { simkl: 37089, slug: "cowboy-bebop", mal: "1", anidb: "23" },
      },
      seasons: [
        {
          number: 1,
          episodes: [{ number: 1, tvdb: { season: 1, episode: 1 } }],
        },
      ],
    },
    {
      added_to_watchlist_at: "2020-01-01T00:00:00Z",
      last_watched_at: "2026-05-01T00:00:00Z",
      user_rating: null,
      status: "watching",
      watched_episodes_count: 1,
      anime_type: "tv",
      mapped_tvdb_seasons: [2],
      show: {
        title: "Shingeki no Kyojin Season 2",
        year: 2017,
        ids: { simkl: 439744, imdb: "tt2560140", tmdb: "1429" },
      },
      seasons: [
        {
          number: 1,
          episodes: [{ number: 1, tvdb: { season: 2, episode: 1 } }],
        },
      ],
    },
    {
      added_to_watchlist_at: "2025-01-01T00:00:00Z",
      last_watched_at: null,
      user_rating: null,
      status: "plantowatch",
      anime_type: "movie",
      show: {
        title: "Attack on Titan: The Last Attack",
        year: 2024,
        ids: { simkl: 2544548, tmdb: "1333100" },
      },
    },
  ],
};
