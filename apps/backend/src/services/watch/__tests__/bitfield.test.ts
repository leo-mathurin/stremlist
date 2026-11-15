import { describe, expect, it } from "vite-plus/test";
import { deflateSync } from "node:zlib";
import type { SeriesVideo } from "../bitfield";
import { stremioOrder, watchedVideos } from "../bitfield";

function video(season: number, episode: number, released?: string) {
  return { id: `tt0944947:${season}:${episode}`, season, episode, released };
}

/** A `watched` field as Stremio writes it: the last watched one anchors it. */
function field(videos: SeriesVideo[], watched: string[]): string {
  const bits = Buffer.alloc(Math.ceil(videos.length / 8));
  let last = 0;
  videos.forEach((entry, index) => {
    if (!watched.includes(entry.id)) return;
    bits[index >> 3] |= 1 << (index & 7);
    last = index;
  });
  return `${videos[last].id}:${last + 1}:${deflateSync(bits).toString("base64")}`;
}

describe("Stremio's watched field", () => {
  const season1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => video(1, n));

  it("reads the watched episodes, across bytes", () => {
    const watched = ["tt0944947:1:1", "tt0944947:1:9", "tt0944947:1:10"];
    expect([...watchedVideos(field(season1, watched), season1)]).toEqual(
      watched,
    );
  });

  it("decodes a field from Stremio itself", () => {
    // Episode 1:1 of 10 watched, as stremio-watched-bitfield encodes it.
    const real = `tt0944947:1:1:1:${deflateSync(Buffer.from([1, 0])).toString("base64")}`;
    expect([...watchedVideos(real, season1)]).toEqual(["tt0944947:1:1"]);
  });

  it("realigns on the anchor when episodes were added before it", () => {
    const before = field(season1, ["tt0944947:1:2", "tt0944947:1:3"]);
    // Two specials now come first in Stremio's order.
    const now = stremioOrder([...season1, video(0, 1), video(0, 2)]);
    expect([...watchedVideos(before, now)]).toEqual([
      "tt0944947:1:2",
      "tt0944947:1:3",
    ]);
  });

  it("counts nothing for a field it cannot place or read", () => {
    expect(watchedVideos("tt0944947:9:9:3:eJxjAAAAAQAB", season1).size).toBe(0);
    expect(watchedVideos("not a field", season1).size).toBe(0);
    expect(watchedVideos(undefined, season1).size).toBe(0);
  });

  it("orders episodes by season, episode, then release", () => {
    const ordered = stremioOrder([
      video(2, 1),
      video(1, 2),
      video(1, 1, "2020-01-02"),
      video(1, 1, "2020-01-01"),
    ]);
    expect(ordered.map((v) => `${v.id}@${v.released ?? ""}`)).toEqual([
      "tt0944947:1:1@2020-01-01",
      "tt0944947:1:1@2020-01-02",
      "tt0944947:1:2@",
      "tt0944947:2:1@",
    ]);
  });
});
