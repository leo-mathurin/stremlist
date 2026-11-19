import { http, passthrough } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { useBackgroundTasks } from "../../test/helpers/background.test-utils";
import { db, resetRpc } from "../../test/helpers/mock-supabase";
import { useMswServer } from "../../test/helpers/msw.test-utils";
import { findPosters, resetPosterMemory } from "../title-posters";
import { resetTvdbToken } from "../tvdb";

const server = useMswServer();
useBackgroundTasks();

beforeEach(() => {
  db.reset();
  resetRpc();
  resetPosterMemory();
  resetTvdbToken();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.runIf(process.env.TVDB_LIVE_API_KEY)(
  "findPosters on TheTVDB, live",
  () => {
    beforeEach(() => {
      vi.stubEnv("TVDB_API_KEY", process.env.TVDB_LIVE_API_KEY ?? "");
      server.use(
        http.all(/^https:\/\/[a-z0-9.-]*thetvdb\.com\//, () => passthrough()),
      );
    });
    it("finds series and movie posters by IMDb ID, small for the preview", async () => {
      const titles = [
        { id: "tt1190634", type: "series" as const },
        { id: "tt0903747", type: "series" as const },
        { id: "tt15398776", type: "movie" as const },
        { id: "tt0111161", type: "movie" as const },
      ];
      const stremio = await findPosters("tvdb", titles, {
        budgetMs: 20_000,
        size: "stremio",
      });
      expect([...stremio.keys()].sort((a, b) => a.localeCompare(b))).toEqual(
        titles.map(({ id }) => id).sort((a, b) => a.localeCompare(b)),
      );
      for (const url of stremio.values()) {
        expect(url).toMatch(/^https:\/\/artworks\.thetvdb\.com\/.+\.jpg$/u);
        expect(url).not.toMatch(/_t\.jpg$/u);
      }
      const preview = await findPosters("tvdb", titles, {
        budgetMs: 0,
        size: "preview",
      });
      expect(preview.get("tt1190634")).toBe(
        stremio.get("tt1190634")?.replace(/\.jpg$/u, "_t.jpg"),
      );
      const image = await fetch(preview.get("tt0111161") ?? "");
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe("image/jpeg");
    });

    it("finds no poster for an IMDb ID that TheTVDB does not know", async () => {
      const posters = await findPosters(
        "tvdb",
        [{ id: "tt99999999999", type: "movie" }],
        { budgetMs: 20_000, size: "stremio" },
      );
      expect(posters.size).toBe(0);
      expect(db.getTable("title_posters")).toMatchObject([
        { source: "tvdb", imdb_id: "tt99999999999", poster: null },
      ]);
    });
  },
);
