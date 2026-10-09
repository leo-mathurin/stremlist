import type { DisplayMode, TitleType } from "./constants";
import { CHART_BY_ID } from "./imdb-charts";
import type { ProviderId, SourceId } from "./providers";
import { PROVIDERS, sourceRequiresConnection } from "./providers";
import { storedSourceNoun } from "./source-problems";

/**
 * Merged Lists: one List that reads several Source lists and shows their
 * Titles once each, in the same Catalogs. See CONTEXT.md and ADR 0006.
 * Pure, so the configure page and the backend check the same rules.
 */

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
export const MAX_LISTS = 10;

/** A List reads at most this many Source lists, its first one included. */
export const MAX_SOURCES_PER_LIST = 5;

/** Source lists of all the Lists of one Account together. */
export const MAX_SOURCES_PER_ACCOUNT = 20;

/** Every Source list of a List, its first one first. */
export function listSources(list: MergeableList): ListSource[] {
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
export function sourceKey(source: ListSource): string {
  return `${source.provider}:${source.sourceRef}`;
}

/**
 * Every Source list of a List, in order, as one string: equal for two Lists
 * that read the same Source lists in the same order.
 */
export function listSourcesKey(list: MergeableList): string {
  return listSources(list).map(sourceKey).join(",");
}

export function isMergedList(list: MergeableList): boolean {
  return (list.mergedSources?.length ?? 0) > 0;
}

/** The Providers whose Connection one of the List's Source lists needs. */
export function connectionProviders(list: MergeableList): ProviderId[] {
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
export function listRequiresConnection(list: MergeableList): boolean {
  return connectionProviders(list).length > 0;
}

/**
 * The only Title type that a Source list can contain, or null when it can
 * contain movies and series.
 */
export function sourceTitleType(
  provider: ProviderId,
  ref: string,
): TitleType | null {
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
function sourceName(source: ListSource): string {
  const chart =
    source.provider === "imdb" ? CHART_BY_ID.get(source.sourceRef) : undefined;
  if (chart) return chart.label;
  if (source.provider === "trakt" && TRAKT_NAMES[source.sourceRef]) {
    return TRAKT_NAMES[source.sourceRef];
  }
  return `the ${PROVIDERS[source.provider].label} ${storedSourceNoun(source.provider, source.sourceRef)}`;
}

/** "the JustWatch list does", "A, B and C do": the names and the verb that agrees. */
export function sourcesWithVerb(
  sources: ListSource[],
  singular: string,
  plural: string,
): string {
  const names = sources.map(sourceName);
  const last = names.pop();
  return names.length > 0
    ? `${names.join(", ")} and ${last} ${plural}`
    : `${last} ${singular}`;
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * The Source lists of a merged List that contain only movies or only
 * series. Empty for a List with one Source list: it shows what it has.
 */
function singleTypeSources(
  list: MergeableList,
): Record<TitleType, ListSource[]> {
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
): string | null {
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
export function allowedDisplayModes(list: MergeableList): DisplayMode[] {
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
export function sourcesWithoutDates(list: MergeableList): ListSource[] {
  if (!isMergedList(list)) return [];
  return listSources(list).filter(
    (source) => !sourceHasAddedDates(source.provider, source.sourceRef),
  );
}

/** Whether a List can sort by this option: "Date added" needs dates. */
export function isSortAllowed(
  list: MergeableList,
  sortOption: string,
): boolean {
  return (
    !sortOption.startsWith("added_at") || sourcesWithoutDates(list).length === 0
  );
}

/** Why the Lists of one Account cannot be saved together. */
export interface AccountListsProblem {
  reason: "too_many_lists" | "duplicate_source" | "too_many_sources";
  /** The message for the user. */
  message: string;
}

/**
 * The first rule that the Lists of one Account break together, or null:
 * at most MAX_LISTS Lists, each Source list in only one of them, and at
 * most MAX_SOURCES_PER_ACCOUNT Source lists in all.
 */
export function accountListsProblem(
  lists: readonly MergeableList[],
): AccountListsProblem | null {
  if (lists.length > MAX_LISTS) {
    return {
      reason: "too_many_lists",
      message: `You can have at most ${MAX_LISTS} lists.`,
    };
  }
  const keys = lists.flatMap((list) => listSources(list).map(sourceKey));
  if (new Set(keys).size !== keys.length) {
    return {
      reason: "duplicate_source",
      message: "Each list can only be added once.",
    };
  }
  if (keys.length > MAX_SOURCES_PER_ACCOUNT) {
    return {
      reason: "too_many_sources",
      message: `You can have at most ${MAX_SOURCES_PER_ACCOUNT} Source lists in all your Lists.`,
    };
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
    return singleTypeReason(list, {
      both: "this List must show movies and TV shows",
      movie: "this List cannot show only TV shows",
      series: "this List cannot show only movies",
    });
  }

  if (!isSortAllowed(list, list.sortOption)) {
    const undated = sourcesWithoutDates(list);
    return `${capitalize(sourcesWithVerb(undated, "does", "do"))} not give the date when each Title was added, so this List cannot sort by date added.`;
  }
  return null;
}
