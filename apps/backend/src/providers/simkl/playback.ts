import { z } from "zod";
import type { ConnectionAccess, SourceEntry, SourceSnapshot } from "../types";
import { simklRequest } from "./api";
import { toEntry } from "./entries";
import type { SimklKind } from "./library";
import { parseIds, rawIdsSchema, syncLibrary, toInt } from "./library";
import { playbackKey, readState, STATE_VERSION, writeState } from "./state";

/**
 * Sessions age out after 7 days (Simkl free), 30 (PRO) or 90 (VIP) without
 * a change in /sync/activities: read them again at least once a day.
 */
const PLAYBACK_MAX_AGE_MS = 24 * 60 * 60_000;

const rawTitleSchema = z.object({
  title: z.string().nullish(),
  year: z.number().nullish(),
  anime_type: z.string().nullish(),
  ids: rawIdsSchema.nullish(),
});

/** The shape of GET /sync/playback in Simkl's OpenAPI (PlaybackSession). */
const rawSessionSchema = z.object({
  paused_at: z.string().nullish(),
  type: z.string().nullish(),
  movie: rawTitleSchema.nullish(),
  show: rawTitleSchema.nullish(),
  anime: rawTitleSchema.nullish(),
});
type RawSession = z.infer<typeof rawSessionSchema>;

const playbackEntrySchema = z.object({
  imdbId: z.string().optional(),
  externalIds: z
    .object({
      simkl: z.number().optional(),
      tmdb: z
        .object({ id: z.number(), type: z.enum(["movie", "series"]) })
        .optional(),
    })
    .optional(),
  type: z.enum(["movie", "series"]).optional(),
  title: z.string().optional(),
  year: z.number().optional(),
  sourceUrl: z.string().optional(),
  addedAt: z.string().optional(),
});

const playbackSnapshotSchema = z.object({
  version: z.number(),
  /** The authorization that read the sessions (`ConnectionAccess`). */
  authorization: z.string(),
  /** The /sync/activities timestamps that the read matches. */
  gate: z.string(),
  fetchedAt: z.number(),
  entries: z.array(playbackEntrySchema),
});
type PlaybackSnapshot = z.infer<typeof playbackSnapshotSchema>;

function sessionKind(session: RawSession): SimklKind {
  if (session.anime) return "anime";
  return session.show ? "shows" : "movies";
}

/**
 * One entry per title, the oldest pause first (the canonical order of a
 * dated Source list). Several paused episodes of one series are one entry,
 * dated by the newest pause.
 */
function playbackEntries(sessions: RawSession[]): SourceEntry[] {
  const newest = new Map<number, { entry: SourceEntry; pausedAt: string }>();
  for (const session of sessions) {
    const media = session.anime ?? session.show ?? session.movie;
    const { simkl, ...ids } = parseIds(media?.ids ?? {});
    if (!simkl) continue;
    const pausedAt = session.paused_at ?? "";
    const previous = newest.get(simkl);
    if (previous && previous.pausedAt >= pausedAt) continue;
    newest.set(simkl, {
      pausedAt,
      entry: toEntry(
        {
          simkl,
          kind: sessionKind(session),
          ...ids,
          title: media?.title ?? undefined,
          year: toInt(media?.year),
          animeType: media?.anime_type ?? undefined,
        },
        pausedAt || undefined,
      ),
    });
  }
  return [...newest.values()]
    .sort((a, b) => (a.pausedAt < b.pausedAt ? -1 : 1))
    .map(({ entry }) => entry);
}

/**
 * "Continue watching": the user's paused playback sessions. A read costs one
 * call of the user's daily Simkl quota, so it happens only when
 * /sync/activities moved (a pause, or a watched mark that hides a session)
 * or once a day.
 */
export async function fetchPlayback(
  connection: ConnectionAccess,
): Promise<SourceSnapshot> {
  const { activities } = await syncLibrary(connection);
  const gate = JSON.stringify([
    activities.all ?? null,
    activities.tv_shows?.playback ?? null,
    activities.anime?.playback ?? null,
    activities.movies?.playback ?? null,
  ]);
  const key = playbackKey(connection.accountId);
  const previous = await readState(key, playbackSnapshotSchema);
  if (
    previous?.version === STATE_VERSION &&
    previous.authorization === connection.authorization &&
    previous.gate === gate &&
    Date.now() - previous.fetchedAt < PLAYBACK_MAX_AGE_MS
  ) {
    return { entries: previous.entries, complete: true };
  }

  const token = await connection.getAccessToken();
  const sessions = await simklRequest(
    "/sync/playback",
    z.array(rawSessionSchema),
    { token },
  );
  const entries = playbackEntries(sessions);
  await writeState(key, {
    version: STATE_VERSION,
    authorization: connection.authorization,
    gate,
    fetchedAt: Date.now(),
    entries,
  } satisfies PlaybackSnapshot);
  return { entries, complete: true };
}
