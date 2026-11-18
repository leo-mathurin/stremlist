import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { vi } from "vite-plus/test";

/** Trakt list items for these Titles, as the Trakt list endpoints send them. */
export function traktItems(metas: StremioMeta[]) {
  return metas.map((meta) => {
    const media = { title: meta.name, ids: { imdb: meta.id } };
    return meta.type === "series"
      ? { type: "show", show: media }
      : { type: "movie", movie: media };
  });
}

/** Configures a Trakt app, so that the Trakt adapter sends its requests. */
export function useTraktApp() {
  vi.stubEnv("TRAKT_CLIENT_ID", "trakt-app");
  vi.stubEnv("TRAKT_CLIENT_SECRET", "");
}
