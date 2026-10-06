import type { DisplayMode } from "./constants";
import { CHART_BY_ID } from "./imdb-charts";
import type { ProviderId } from "./providers";
import { PROVIDERS, sourceRequiresConnection } from "./providers";
import { storedSourceNoun } from "./source-problems";

/**
 * Merged Lists: one List that reads several Source lists and shows their
 * Titles once each, in the same Catalogs. See CONTEXT.md and ADR 0006.
 * Pure, so the configure page and the backend check the same rules.
 */

/** One Source list of a List. */
export interface ListSource {
  provider: ProviderId;
  sourceRef: string;
}

/** A List as far as merging cares: its first Source list, then the others. */
export interface MergeableList extends ListSource {
  mergedSources?: readonly ListSource[];
}

/** A List reads at most this many Source lists, its first one included. */
export const MAX_SOURCES_PER_LIST = 5;

/** Source lists of all the Lists of one Account together. */
export const MAX_SOURCES_PER_ACCOUNT = 20;

/** Every Source list of a List, its first one first. */
export function listSources(list: MergeableList): ListSource[] {
  return [
    { provider: list.provider, sourceRef: list.sourceRef },
    ...(list.mergedSources ?? []).map(({ provider, sourceRef }) => ({
      provider,
      sourceRef,
    })),
  ];
}

/** Source lists are unique by Provider and reference. */
export function sourceKey(source: ListSource): string {
  return `${source.provider}:${source.sourceRef}`;
}

export function isMergedList(list: MergeableList): boolean {
  return (list.mergedSources?.length ?? 0) > 0;
}

/** A List needs a Connection when one of its Source lists does. */
export function listRequiresConnection(list: MergeableList): boolean {
  return listSources(list).some((source) =>
    sourceRequiresConnection(source.provider, source.sourceRef),
  );
}

/**
 * The only Title type that a Source list can contain, or null when it can
 * contain movies and series.
 */
export function sourceTitleType(
  provider: ProviderId,
  ref: string,
): "movie" | "series" | null {
  if (provider === "imdb") {
    const mode = CHART_BY_ID.get(ref)?.defaultDisplayMode;
    return mode === "movie" || mode === "series" ? mode : null;
  }
  // Up Next lists the series in progress (docs/providers.md).
  if (provider === "trakt" && ref === "me/up-next") return "series";
  return null;
}

const TRAKT_DATED =
  /^(?:(?:me|users\/[^/]+)\/(?:watchlist|lists\/[^/]+)|lists\/[^/]+|me\/history|me\/collection)$/;
const SIMKL_DATED =
  /^me\/(?:plantowatch|watching|completed|hold|dropped|history)$/;

/**
 * Whether the Provider gives the date when each Title joined this Source
 * list (added, watched or collected). Charts, recommendations and lists in
 * the owner's order have no date.
 */
export function sourceHasAddedDates(
  provider: ProviderId,
  ref: string,
): boolean {
  switch (provider) {
    case "imdb":
      return !CHART_BY_ID.has(ref);
    case "trakt":
      return TRAKT_DATED.test(ref);
    case "simkl":
      return SIMKL_DATED.test(ref);
    case "mdblist":
      return ref === "me/watchlist";
    default:
      return false;
  }
}

const TRAKT_NAMES: Record<string, string> = {
  trending: "Trakt Trending",
  popular: "Trakt Popular",
  anticipated: "Trakt Anticipated",
  "me/recommendations": "Trakt Recommendations",
  "me/up-next": "Trakt Up Next",
};

/**
 * A short name for a Source list inside a sentence, such as "Top 250 Movies"
 * or "the SensCritique list".
 */
export function sourceName(source: ListSource): string {
  const chart =
    source.provider === "imdb" ? CHART_BY_ID.get(source.sourceRef) : undefined;
  if (chart) return chart.label;
  if (source.provider === "trakt" && TRAKT_NAMES[source.sourceRef]) {
    return TRAKT_NAMES[source.sourceRef];
  }
  return `the ${PROVIDERS[source.provider].label} ${storedSourceNoun(source.provider, source.sourceRef)}`;
}

/** "A has", "A and B have": the names and the verb that agrees with them. */
function subject(sources: ListSource[], singular: string, plural: string) {
  const names = joinSourceNames(sources);
  const verb = sources.length > 1 ? plural : singular;
  return `${names.charAt(0).toUpperCase()}${names.slice(1)} ${verb}`;
}

/** "Top 250 Movies, Trakt Popular and the JustWatch list". */
export function joinSourceNames(sources: ListSource[]): string {
  const names = sources.map(sourceName);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/**
 * The display modes that keep every Title type of a merged List: a Source
 * list with only movies rules out "TV shows only", and the reverse.
 */
export function allowedDisplayModes(list: MergeableList): DisplayMode[] {
  if (!isMergedList(list)) return ["split", "movie", "series"];
  const types = new Set(
    listSources(list).flatMap((source) => {
      const type = sourceTitleType(source.provider, source.sourceRef);
      return type ? [type] : [];
    }),
  );
  return (["split", "movie", "series"] as const).filter(
    (mode) =>
      mode === "split" || !types.has(mode === "movie" ? "series" : "movie"),
  );
}

export function isAddedDateSort(sortOption: string): boolean {
  return sortOption.startsWith("added_at");
}

/**
 * The Source lists that stop a merged List from sorting by date added. A
 * List with one Source list keeps its Provider's order and never has any.
 */
export function sourcesWithoutDates(list: MergeableList): ListSource[] {
  if (!isMergedList(list)) return [];
  return listSources(list).filter(
    (source) => !sourceHasAddedDates(source.provider, source.sourceRef),
  );
}

/**
 * The first rule that a List breaks, as a message for the user, or null.
 * Rules: at most MAX_SOURCES_PER_LIST Source lists, each one once, a
 * display mode that keeps every single-type Source list, and "Date added"
 * only when every Source list gives dates.
 */
export function listMergeProblem(
  list: MergeableList & { displayMode: DisplayMode; sortOption: string },
): string | null {
  const sources = listSources(list);
  if (sources.length > MAX_SOURCES_PER_LIST) {
    return `A List can merge at most ${MAX_SOURCES_PER_LIST} Source lists.`;
  }
  if (new Set(sources.map(sourceKey)).size !== sources.length) {
    return "Each list can only be added once.";
  }
  if (sources.length === 1) return null;

  if (!allowedDisplayModes(list).includes(list.displayMode)) {
    const movies = sources.filter(
      (source) =>
        sourceTitleType(source.provider, source.sourceRef) === "movie",
    );
    const series = sources.filter(
      (source) =>
        sourceTitleType(source.provider, source.sourceRef) === "series",
    );
    if (movies.length > 0 && series.length > 0) {
      return `${subject(movies, "has", "have")} only movies and ${subject(series, "has", "have")} only TV shows, so this List must show movies and TV shows.`;
    }
    return movies.length > 0
      ? `${subject(movies, "has", "have")} only movies, so this List cannot show only TV shows.`
      : `${subject(series, "has", "have")} only TV shows, so this List cannot show only movies.`;
  }

  const undated = sourcesWithoutDates(list);
  if (isAddedDateSort(list.sortOption) && undated.length > 0) {
    return `${subject(undated, "does", "do")} not give the date when each Title was added, so this List cannot sort by date added.`;
  }
  return null;
}
