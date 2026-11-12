/**
 * A library item that may hold new watched titles: compare it with the
 * Account's watch state, save the state, then queue a write for each
 * Destination. The state is the only reference for "already sent": its
 * conditional write lets one run claim a title, so the trigger, the events
 * and the sweep never send it twice.
 */
import { IMDB_TITLE_ID_PATTERN } from "@stremlist/shared/constants";
import type { ProviderId } from "@stremlist/shared/providers";
import { supabase } from "../../lib/supabase";
import type { LibraryItem } from "../stremio";
import type { WatchedTitle } from "./library";
import {
  episodeTitles,
  mtimeOf,
  newMovie,
  UNLISTED,
  watchedEpisodes,
} from "./library";
import type { WatchState } from "./state";
import { readState, writeState } from "./state";

type Version = Awaited<ReturnType<typeof readState>>;

/** Tries before giving up on a state that other runs keep changing. */
const SAVE_TRIES = 5;
/** Rows per answer when reading the queue back (PostgREST's page limit). */
const QUEUE_PAGE = 1000;

/**
 * `state` with what `items` show as watched, as the Watched baseline keeps
 * it (series as Stremio's field). False when nothing changed.
 */
export function withItems(
  state: WatchState,
  items: LibraryItem[],
  checkedAt?: number,
): WatchState | false {
  const next: WatchState = {
    ...state,
    movies: [...state.movies],
    series: { ...state.series },
  };
  let changed = checkedAt !== undefined && checkedAt > state.checkedAt;
  if (checkedAt !== undefined) {
    next.checkedAt = Math.max(checkedAt, state.checkedAt);
  }
  for (const item of items) {
    if (!isTitle(item)) continue;
    if (item.type === "movie" && (item.state?.timesWatched ?? 0) > 0) {
      if (!next.movies.includes(item._id)) {
        next.movies.push(item._id);
        changed = true;
      }
    } else if (item.type === "series" && item.state?.watched) {
      if (next.series[item._id] !== item.state.watched) {
        next.series[item._id] = item.state.watched;
        changed = true;
      }
    }
  }
  if (!changed) return false;
  next.savedAt = Date.now();
  return next;
}

/**
 * The episodes ("season:episode") that the state has for a series, or null
 * when its baseline field cannot be placed in Cinemeta's list any more.
 */
async function knownEpisodes(
  imdbId: string,
  stored: string | string[] | undefined,
): Promise<Set<string> | null> {
  if (Array.isArray(stored)) return new Set(stored);
  const known = await watchedEpisodes(imdbId, stored);
  return known instanceof Set ? known : null;
}

/** Only IMDb titles can go to a Destination (other addons' IDs cannot). */
const isTitle = (item: LibraryItem) => IMDB_TITLE_ID_PATTERN.test(item._id);

/**
 * The titles of `items` that `state` does not have, and the state with
 * them. Series keep every episode ever seen watched.
 */
export async function diffItems(
  state: WatchState,
  items: LibraryItem[],
  checkedAt?: number,
): Promise<{ titles: WatchedTitle[]; next: WatchState | false }> {
  const next: WatchState = {
    ...state,
    movies: [...state.movies],
    series: { ...state.series },
  };
  let changed = false;
  const titles: WatchedTitle[] = [];
  /** The oldest change of an item to compare again at the next sweep. */
  let retryFrom = Number.POSITIVE_INFINITY;
  for (const item of items) {
    if (!isTitle(item)) continue;
    if (item.type === "movie") {
      const movie = newMovie(item, next.movies.includes(item._id));
      if (movie.length > 0) {
        next.movies.push(item._id);
        titles.push(...movie);
        changed = true;
      }
      continue;
    }
    const field = item.state?.watched;
    const stored = next.series[item._id];
    if (item.type !== "series" || !field || field === stored) continue;
    const [known, now] = await Promise.all([
      knownEpisodes(item._id, stored),
      watchedEpisodes(item._id, field),
    ]);
    // Cinemeta has no episode list for it: send nothing. A list of
    // episodes already sent stays, so none of them is sent again later.
    if (now === UNLISTED) {
      if (!Array.isArray(stored)) {
        next.series[item._id] = field;
        changed = true;
      }
      continue;
    }
    // Cinemeta cannot place the field now: the next sweep compares it again.
    if (!now) {
      retryFrom = Math.min(retryFrom, mtimeOf(item));
      continue;
    }
    if (!known) {
      // The baseline cannot be read any more: what is watched now becomes
      // the reference, and nothing of it is sent.
      next.series[item._id] = [...now];
      changed = true;
      continue;
    }
    const fresh = [...now].filter((key) => !known.has(key));
    if (fresh.length === 0) continue;
    next.series[item._id] = [...new Set([...known, ...now])];
    titles.push(...episodeTitles(item, fresh));
    changed = true;
  }
  if (checkedAt !== undefined) {
    const upTo = Math.min(checkedAt, retryFrom - 1);
    if (upTo > state.checkedAt) {
      next.checkedAt = upTo;
      changed = true;
    }
  }
  if (!changed) return { titles, next: false };
  next.savedAt = Date.now();
  return { titles, next };
}

/** Queue one write per Destination and title. */
async function queueWrites(
  accountId: string,
  destinations: readonly ProviderId[],
  titles: WatchedTitle[],
): Promise<void> {
  const rows = titles.flatMap((title) =>
    destinations.map((provider) => ({
      account_id: accountId,
      provider,
      imdb_id: title.imdbId,
      item_type: title.type,
      season: title.episode?.season ?? 0,
      episode: title.episode?.episode ?? 0,
      watched_at: title.watchedAt,
    })),
  );
  if (rows.length === 0) return;
  const { error } = await supabase.rpc("queue_watch_writes", { p_rows: rows });
  if (error) throw error;
}

/**
 * Whether the insert of these writes committed: every one of them, for each
 * Destination, is in the queue. A failed insert leaves some out.
 */
async function allQueued(
  accountId: string,
  destinations: readonly ProviderId[],
  titles: WatchedTitle[],
): Promise<boolean> {
  const queued = new Set<string>();
  // Every page: a bulk mark can queue more rows than one answer holds.
  for (let from = 0; ; from += QUEUE_PAGE) {
    const { data, error } = await supabase
      .from("watch_writes")
      .select("provider, imdb_id, season, episode")
      .eq("account_id", accountId)
      .in("imdb_id", [...new Set(titles.map((t) => t.imdbId))])
      .order("id")
      .range(from, from + QUEUE_PAGE - 1);
    if (error) throw error;
    for (const w of data) {
      queued.add(`${w.provider}|${w.imdb_id}|${w.season}|${w.episode}`);
    }
    if (data.length < QUEUE_PAGE) break;
  }
  return titles.every((t) =>
    destinations.every((provider) =>
      queued.has(
        `${provider}|${t.imdbId}|${t.episode?.season ?? 0}|${t.episode?.episode ?? 0}`,
      ),
    ),
  );
}

/**
 * Takes `titles` out of the state again after their writes failed to queue,
 * and moves the sweep back to `checkedAt` so it reads their items again.
 */
async function forgetTitles(
  accountId: string,
  titles: WatchedTitle[],
  checkedAt: number,
): Promise<void> {
  for (let attempt = 0; attempt < SAVE_TRIES; attempt++) {
    const { state, etag } = await readState(accountId);
    if (!state) return;
    const next: WatchState = {
      ...state,
      checkedAt: Math.min(state.checkedAt, checkedAt),
      movies: state.movies.filter(
        (id) => !titles.some((t) => t.type === "movie" && t.imdbId === id),
      ),
      series: { ...state.series },
    };
    for (const title of titles) {
      const stored = next.series[title.imdbId];
      if (!title.episode || !Array.isArray(stored)) continue;
      const key = `${title.episode.season}:${title.episode.episode}`;
      next.series[title.imdbId] = stored.filter((k) => k !== key);
    }
    if (await writeState(accountId, next, etag)) return;
  }
}

/**
 * Sends what `items` show as newly watched to the Destinations. Nothing
 * happens without a Watched baseline of the same Stremio link (`link`, the
 * `linkOf` the sealed key that read `items`). The state is saved first,
 * over the version this run compared: of two runs that see the same title,
 * only the one whose save lands queues it.
 */
export async function recordItems(
  accountId: string,
  destinations: readonly ProviderId[],
  items: LibraryItem[],
  options: { link: string; version?: Version; checkedAt?: number },
): Promise<WatchedTitle[]> {
  let version = options.version ?? (await readState(accountId));
  for (let attempt = 0; attempt < SAVE_TRIES; attempt++) {
    if (version.state?.link !== options.link) return [];
    const { titles, next } = await diffItems(
      version.state,
      items,
      options.checkedAt,
    );
    if (!next) return [];
    if (await writeState(accountId, next, version.etag)) {
      try {
        await queueWrites(accountId, destinations, titles);
      } catch (error) {
        // Not queued: let a later read find these titles again. An answer
        // lost after the insert committed must keep them, or they would be
        // sent twice.
        const committed = await allQueued(
          accountId,
          destinations,
          titles,
        ).catch(() => true);
        if (!committed) {
          await forgetTitles(accountId, titles, version.state.checkedAt).catch(
            () => undefined,
          );
        }
        throw error;
      }
      return titles;
    }
    version = await readState(accountId);
  }
  throw new Error("The watch state stayed busy");
}
