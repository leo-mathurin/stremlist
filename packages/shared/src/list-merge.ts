import type { DisplayMode, TitleType } from "./constants";
import { CHART_BY_ID, imdbChartOf } from "./imdb-charts";
import type { ProviderId, SourceId } from "./providers";
import { PROVIDERS, sourceRequiresConnection, staticSource } from "./providers";
import { storedSourceNoun } from "./source-problems";
import { SIMKL_CHART_TYPE_INFO, simklGenreChartOf } from "./simkl-charts";

/** One Source list of a List. */
export interface ListSource extends SourceId {
  /**
   * For a merged Source list: the title of the List it came from, shown on
   * the configure page. Never part of its identity.
   */
  label?: string;
}

/** A List as far as merging cares: its first Source list, then the others. */
export interface MergeableList extends ListSource {
  /** The label of the first Source list, when it was merged in earlier. */
  sourceLabel?: string;
  mergedSources?: readonly ListSource[];
}

/** An Account has at most this many Lists. */
export const MAX_LISTS = 50;

/** A List reads at most this many Source lists, its first one included. */
export const MAX_SOURCES_PER_LIST = 5;

/** Source lists of all the Lists of one Account together. */
export const MAX_SOURCES_PER_ACCOUNT = 50;

/** Every Source list of a List, its first one first. */
export function listSources(list: MergeableList) {
  return [
    {
      provider: list.provider,
      sourceRef: list.sourceRef,
      label: list.sourceLabel,
    },
    ...(list.mergedSources ?? []),
  ];
}

/** Source lists are unique by Provider and reference. */
export function sourceKey(source: ListSource) {
  return `${source.provider}:${source.sourceRef}`;
}

/**
 * Every Source list of a List, in order, as one string: equal for two Lists
 * that read the same Source lists in the same order.
 */
export function listSourcesKey(list: MergeableList) {
  return listSources(list).map(sourceKey).join(",");
}

export function isMergedList(list: MergeableList) {
  return (list.mergedSources?.length ?? 0) > 0;
}

/** The Providers whose Connection one of the List's Source lists needs. */
export function connectionProviders(list: MergeableList) {
  return [
    ...new Set(
      listSources(list)
        .filter((source) =>
          sourceRequiresConnection(source.provider, source.sourceRef),
        )
        .map((source) => source.provider),
    ),
  ];
}

/** A List needs a Connection when one of its Source lists does. */
export function listRequiresConnection(list: MergeableList) {
  return connectionProviders(list).length > 0;
}

/**
 * The only Title type that a Source list can contain, or null when it can
 * contain movies and series.
 */
export function sourceTitleType(provider: ProviderId, ref: string) {
  const mode = imdbChartOf({ provider, sourceRef: ref })?.defaultDisplayMode;
  if (mode === "movie" || mode === "series") return mode;
  const genre = provider === "simkl" ? simklGenreChartOf(ref) : null;
  if (genre) return SIMKL_CHART_TYPE_INFO[genre.type].titleType ?? null;
  return staticSource(provider, ref)?.titleType ?? null;
}

const TRAKT_DATED =
  /^(?:(?:me|users\/[^/]+)\/(?:watchlist|favorites|ratings|history|collection|lists\/[^/]+)|lists\/[^/]+|me\/continue-watching)$/;
const SIMKL_DATED =
  /^me\/(?:plantowatch|watching|completed|hold|dropped|history|ratings|continue-watching)$/;

/**
 * Whether the Provider gives the date when each Title joined this Source
 * list (added, watched, collected or paused). Charts, calendars,
 * recommendations and lists in the owner's order have no date.
 */
export function sourceHasAddedDates(provider: ProviderId, ref: string) {
  switch (provider) {
    case "imdb":
      return !CHART_BY_ID.has(ref);
    case "trakt":
      return TRAKT_DATED.test(ref);
    case "simkl":
      return SIMKL_DATED.test(ref);
    case "mdblist":
      return /^me\/(?:watchlist|ratings|history|collection)$/.test(ref);
    case "letterboxd":
      return /^users\/[^/]+\/diary$/.test(ref);
    case "justwatch":
    case "senscritique":
      return false;
  }
}

function sourceName(source: ListSource) {
  const chart = imdbChartOf(source);
  if (chart) return chart.label;
  const label = PROVIDERS[source.provider].label;
  const known = staticSource(source.provider, source.sourceRef);
  if (known) return `${label} ${known.label}`;
  return `the ${label} ${storedSourceNoun(source.provider, source.sourceRef)}`;
}

/** "the JustWatch list does", "A, B and C do": the names and the verb that agrees. */
export function sourcesWithVerb(
  sources: ListSource[],
  singular: string,
  plural: string,
) {
  const names = sources.map(sourceName);
  const last = names.pop();
  return names.length > 0
    ? `${names.join(", ")} and ${last} ${plural}`
    : `${last} ${singular}`;
}

function capitalize(text: string) {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function singleTypeSources(list: MergeableList) {
  const sources = isMergedList(list) ? listSources(list) : [];
  const ofType = (type: TitleType) =>
    sources.filter(
      (source) => sourceTitleType(source.provider, source.sourceRef) === type,
    );
  return { movie: ofType("movie"), series: ofType("series") };
}

/**
 * Why a merged List limits its display modes and what follows, such as "Top
 * 250 Movies has only movies, so {outcome.movie}.", or null when it does not.
 */
export function singleTypeReason(
  list: MergeableList,
  outcome: Record<"both" | TitleType, string>,
) {
  const { movie, series } = singleTypeSources(list);
  const parts = (
    [
      [movie, "movies"],
      [series, "TV shows"],
    ] as const
  ).flatMap(([sources, kind]) =>
    sources.length > 0
      ? [`${capitalize(sourcesWithVerb(sources, "has", "have"))} only ${kind}`]
      : [],
  );
  if (parts.length === 0) return null;
  const kind =
    movie.length === 0 ? "series" : series.length === 0 ? "movie" : "both";
  return `${parts.join(" and ")}, so ${outcome[kind]}.`;
}

/**
 * The display modes that keep every Title type of a merged List: a Source
 * list with only movies rules out "TV shows only", and the reverse.
 */
export function allowedDisplayModes(list: MergeableList) {
  const { movie, series } = singleTypeSources(list);
  return (["split", "movie", "series"] as const).filter(
    (mode) =>
      mode === "split" ||
      (mode === "movie" ? series.length === 0 : movie.length === 0),
  );
}

/**
 * The Source lists that stop a merged List from sorting by date added. A
 * List with one Source list keeps its Provider's order and never has any.
 */
export function sourcesWithoutDates(list: MergeableList) {
  if (!isMergedList(list)) return [];
  return listSources(list).filter(
    (source) => !sourceHasAddedDates(source.provider, source.sourceRef),
  );
}

/** Whether a List can sort by this option: "Date added" needs dates. */
export function isSortAllowed(list: MergeableList, sortOption: string) {
  return (
    !sortOption.startsWith("added_at") || sourcesWithoutDates(list).length === 0
  );
}

interface AccountListsProblem {
  reason: "too_many_lists" | "duplicate_source" | "too_many_sources";
  message: string;
}

/**
 * The first rule that the Lists of one Account break together, or null:
 * at most MAX_LISTS Lists, each Source list in only one of them, and at
 * most MAX_SOURCES_PER_ACCOUNT Source lists in all.
 */
export function accountListsProblem(lists: readonly MergeableList[]) {
  if (lists.length > MAX_LISTS) {
    return {
      reason: "too_many_lists",
      message: `You can have at most ${MAX_LISTS} lists.`,
    } satisfies AccountListsProblem;
  }
  const keys = lists.flatMap((list) => listSources(list).map(sourceKey));
  if (new Set(keys).size !== keys.length) {
    return {
      reason: "duplicate_source",
      message: "Each list can only be added once.",
    } satisfies AccountListsProblem;
  }
  if (keys.length > MAX_SOURCES_PER_ACCOUNT) {
    return {
      reason: "too_many_sources",
      message: `You can have at most ${MAX_SOURCES_PER_ACCOUNT} lists in total, merged lists included.`,
    } satisfies AccountListsProblem;
  }
  return null;
}

/**
 * The first rule that a List breaks, as a message for the user, or null.
 * Rules: at most MAX_SOURCES_PER_LIST Source lists, each one once, a
 * display mode that keeps every single-type Source list, and "Date added"
 * only when every Source list gives dates.
 */
export function listMergeProblem(
  list: MergeableList & { displayMode: DisplayMode; sortOption: string },
) {
  const sources = listSources(list);
  if (sources.length > MAX_SOURCES_PER_LIST) {
    return `A catalog can merge at most ${MAX_SOURCES_PER_LIST} lists.`;
  }
  if (new Set(sources.map(sourceKey)).size !== sources.length) {
    return "Each list can only be added once.";
  }
  if (!allowedDisplayModes(list).includes(list.displayMode)) {
    return singleTypeReason(list, {
      both: "this list must show movies and TV shows",
      movie: "this list cannot show only TV shows",
      series: "this list cannot show only movies",
    });
  }

  if (!isSortAllowed(list, list.sortOption)) {
    const undated = sourcesWithoutDates(list);
    return `${capitalize(sourcesWithVerb(undated, "does", "do"))} not give the date when each title was added, so this list cannot sort by date added.`;
  }
  return null;
}
