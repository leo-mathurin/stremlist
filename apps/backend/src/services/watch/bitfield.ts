/**
 * Stremio's `watched` field of a series library item, decoded as Stremio's
 * own core does (`stremio-watched-bitfield`). The field is
 * `{anchor video ID}:{anchor length}:{base64 of zlib bits}`: bit `i` is the
 * `i`-th episode in Stremio's order, and the anchor (the last watched
 * episode) realigns the bits when the episode list changed since.
 */
import { inflateSync } from "node:zlib";

export interface SeriesVideo {
  /** `tt…:season:episode` */
  id: string;
  season: number;
  episode: number;
  released?: string;
}

interface WatchedField {
  anchorVideo: string;
  anchorLength: number;
  bits: Uint8Array;
}

function parse(field: string): WatchedField | null {
  // The anchor video ID has colons too: take the last two parts.
  const parts = field.split(":");
  if (parts.length < 3) return null;
  const encoded = parts.pop() ?? "";
  const anchorLength = Number(parts.pop());
  if (!Number.isInteger(anchorLength) || anchorLength < 0) return null;
  try {
    return {
      anchorVideo: parts.join(":"),
      anchorLength,
      bits: inflateSync(Buffer.from(encoded, "base64")),
    };
  } catch {
    return null;
  }
}

function released(video: SeriesVideo): number {
  const time = video.released ? Date.parse(video.released) : Number.NaN;
  return Number.isNaN(time) ? Number.MIN_SAFE_INTEGER : time;
}

/** The episodes in the order of Stremio's bits: season, episode, release. */
export function stremioOrder(videos: SeriesVideo[]): SeriesVideo[] {
  return [...videos].sort(
    (a, b) =>
      a.season - b.season || a.episode - b.episode || released(a) - released(b),
  );
}

/**
 * The IDs of the watched episodes. `videos` must be in Stremio's order
 * (`stremioOrder`). A field whose anchor is not in the list counts as
 * nothing watched, as in Stremio.
 */
export function watchedVideos(
  field: string | undefined,
  videos: SeriesVideo[],
): Set<string> {
  const watched = new Set<string>();
  if (!field) return watched;
  const parsed = parse(field);
  if (!parsed) return watched;
  const anchorIndex = videos.findIndex(
    (video) => video.id === parsed.anchorVideo,
  );
  if (anchorIndex < 0) return watched;
  const offset = parsed.anchorLength - anchorIndex - 1;
  const length = parsed.bits.length * 8;
  videos.forEach((video, index) => {
    const previous = index + offset;
    if (previous < 0 || previous >= length) return;
    if (parsed.bits[previous >> 3] & (1 << (previous & 7))) {
      watched.add(video.id);
    }
  });
  return watched;
}
