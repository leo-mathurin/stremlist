import { z } from "zod";
import { titleType, toEntry } from "./entries";
import type { LibraryItem, SimklKind } from "./library";
import { parseIds, rawIdsSchema } from "./library";
import type { SharedRead } from "./trending";
import { CDN_URL, readCdnFile, sharedRead } from "./trending";

const CALENDAR_FILES: Record<SimklKind, string> = {
  shows: "tv.json",
  anime: "anime.json",
  movies: "movie_release.json",
};

const calendarSchema = z.object({
  calendar: z.array(
    z.object({ simkl_id: z.number(), date: z.string().nullish() }),
  ),
  metadata: z.record(
    z.string(),
    z.object({ ids: rawIdsSchema.nullish() }).loose(),
  ),
});

interface Airings {
  times: Map<number, number[]>;
  ids: Map<number, { imdb?: string; tmdb?: number }>;
}

function parseCalendar(data: unknown) {
  const { calendar, metadata } = calendarSchema.parse(data);
  const times = new Map<number, number[]>();
  for (const { simkl_id: simkl, date } of calendar) {
    const time = Date.parse(date ?? "");
    if (Number.isNaN(time)) continue;
    const list = times.get(simkl) ?? [];
    list.push(time);
    times.set(simkl, list);
  }
  const ids = new Map<number, { imdb?: string; tmdb?: number }>();
  for (const simkl of times.keys()) {
    times.get(simkl)?.sort((a, b) => a - b);
    const { imdb, tmdb } = parseIds(metadata[String(simkl)]?.ids ?? {});
    if (imdb || tmdb) ids.set(simkl, { imdb, tmdb });
  }
  return { times, ids };
}

const reads = new Map<string, SharedRead<Airings>>();
function readCalendar(kind: SimklKind) {
  return readCdnFile(`${CDN_URL}/calendar/v2/${CALENDAR_FILES[kind]}`).then(
    parseCalendar,
  );
}

/** Test hook: forget the shared reads. */
export function clearCalendarReads() {
  reads.clear();
}

function wantsAirings(item: LibraryItem) {
  return titleType(item.kind, item.animeType) === "movie"
    ? item.status === "plantowatch"
    : item.status === "watching";
}

/**
 * "Airing soon": the titles of the library that air in the next weeks, the
 * soonest first. A series shows when its next episode airs; a movie when it
 * comes out. The library gives the IDs; the calendar adds IDs that the
 * library does not have.
 */
export async function airingSoonEntries(
  items: LibraryItem[],
  forceRefresh = false,
) {
  const wanted = items.filter(wantsAirings);
  const kinds = [...new Set(wanted.map((item) => item.kind))];
  const calendars = new Map(
    await Promise.all(
      kinds.map(
        async (kind) =>
          [
            kind,
            await sharedRead(reads, kind, () => readCalendar(kind), {
              forceRefresh,
            }),
          ] as const,
      ),
    ),
  );
  const from = Date.now();
  const airing: { item: LibraryItem; time: number }[] = [];
  for (const item of wanted) {
    const calendar = calendars.get(item.kind);
    const time = calendar?.times.get(item.simkl)?.find((at) => at >= from);
    if (time === undefined) continue;
    const ids = calendar?.ids.get(item.simkl);
    airing.push({
      item: {
        ...item,
        imdb: item.imdb ?? ids?.imdb,
        tmdb: item.tmdb ?? ids?.tmdb,
      },
      time,
    });
  }
  return airing
    .sort((a, b) => a.time - b.time || a.item.simkl - b.item.simkl)
    .map(({ item }) => toEntry(item));
}
