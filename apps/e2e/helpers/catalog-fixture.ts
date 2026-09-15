import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { seedWatchlist } from "./db.js";
import { seedCachedCatalog } from "./r2.js";
import { CATALOG_FIXTURE_USER } from "./test-data.js";

const movie: StremioMeta = {
  id: "tt9900001",
  name: "QA Été & café + cinéma",
  type: "movie",
  poster: "https://stremlist.com/icon.png",
  posterShape: "poster",
  description: "Controlled catalog fixture",
  genres: ["Drama"],
  runtime: "1h 30m",
  imdbRating: "8",
  releaseInfo: "1999",
  released: "1999-12-01T00:00:00.000Z",
};

// Each near-match violates a different filter. Expected results in the tests
// are literal, not calculated by the production filtering/sorting functions.
export const CATALOG_TITLES: StremioMeta[] = [
  movie,
  {
    ...movie,
    id: "tt9900002",
    name: "QA Autumn Drama",
    runtime: "1h 25m",
    imdbRating: "7",
    releaseInfo: "1999",
    released: "1999-01-01T00:00:00.000Z",
  },
  {
    ...movie,
    id: "tt9900003",
    name: "QA Long Drama",
    runtime: "2h 1m",
    imdbRating: "9",
    releaseInfo: "1995",
    released: "1995-01-01T00:00:00.000Z",
  },
  {
    ...movie,
    id: "tt9900004",
    name: "QA Modern Drama",
    runtime: "1h 20m",
    releaseInfo: "2005",
    released: "2005-01-01T00:00:00.000Z",
  },
  {
    ...movie,
    id: "tt9900005",
    name: "QA Low Rated Drama",
    runtime: "1h 20m",
    imdbRating: "6",
    releaseInfo: "1998",
    released: "1998-01-01T00:00:00.000Z",
  },
  {
    ...movie,
    id: "tt9900006",
    name: "QA Comedy Night",
    genres: ["Comedy"],
    runtime: "1h 20m",
    imdbRating: "9",
    releaseInfo: "1996",
    released: "1996-01-01T00:00:00.000Z",
  },
  {
    ...movie,
    id: "tt9900007",
    name: "QA Unknown Details",
    runtime: undefined,
    imdbRating: undefined,
    releaseInfo: undefined,
    released: undefined,
  },
  {
    ...movie,
    id: "tt0903747",
    name: "QA Series",
    type: "series",
    runtime: "45m",
  },
];

/** Only the input data is seeded; all actions use the real API and storage. */
export async function seedCatalog(metas = CATALOG_TITLES) {
  const id = await seedWatchlist(CATALOG_FIXTURE_USER, "Release QA");
  await seedCachedCatalog(id, metas);
  return { userId: CATALOG_FIXTURE_USER, id, catalogId: `wl-${id}-movie` };
}
