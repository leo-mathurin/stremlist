import {
  DISPLAY_MODE_OPTIONS,
  IMDB_RATINGS_REF_PATTERN,
  IMDB_WATCHLIST_SOURCE_ID_PATTERN,
  SORT_OPTIONS,
  SOURCE_REF_MAX_LENGTH,
} from "@stremlist/shared/constants";
import { isChartId } from "@stremlist/shared/imdb-charts";
import type { ListSource } from "@stremlist/shared/list-merge";
import { POSTER_SOURCES } from "@stremlist/shared/poster";
import type { PosterSource } from "@stremlist/shared/poster";
import {
  MAX_LISTS,
  MAX_SOURCES_PER_LIST,
  accountListsProblem,
  listMergeProblem,
  listSources,
  sourceKey,
} from "@stremlist/shared/list-merge";
import type { ProviderId } from "@stremlist/shared/providers";
import {
  PROVIDER_IDS,
  PROVIDERS,
  sourceRequiresConnection,
} from "@stremlist/shared/providers";
import type { AddonAccess, ConfigList } from "@stremlist/shared/stremio.types";
import { z } from "zod";
import { isProviderEnabled } from "../providers/registry";
import type { AccountAccess, ListInput } from "./accounts";
import { withAvailableGenres } from "./catalog-genres";
import {
  catalogSettingsSchema,
  newTitlesSettingsSchema,
} from "./catalog-settings";
import { listConnections } from "./connections";
import { getNewTitlesSummary } from "./detections";
import { normalizeImdbUserId } from "./imdb-scraper";
import { getListReadQueue } from "./read-queue";
import { getListSyncStatuses } from "./sync-status";

export const providerParam = z.enum(PROVIDER_IDS);

const [firstSortOption, ...otherSortOptions] = SORT_OPTIONS;
const sortOptionValues: [string, ...string[]] = [
  firstSortOption.value,
  ...otherSortOptions.map((o) => o.value),
];
const [firstDisplayMode, ...otherDisplayModes] = DISPLAY_MODE_OPTIONS;
const displayModeValues = [
  firstDisplayMode.value,
  ...otherDisplayModes.map((o) => o.value),
] as const;

/** One List as the configure page submits it. */
export const listBody = z.object({
  id: z.guid().optional(),
  provider: providerParam,
  sourceRef: z.string().trim().min(1).max(SOURCE_REF_MAX_LENGTH),
  catalogTitle: z
    .string()
    .trim()
    .max(60, "Catalog titles must be 60 characters or fewer.")
    .optional(),
  sortOption: z.enum(sortOptionValues),
  displayMode: z.enum(displayModeValues).optional(),
  position: z.number().int().min(0).optional(),
  catalogSettings: catalogSettingsSchema.optional(),
  sourceLabel: z.string().trim().max(60).optional(),
  mergedSources: z
    .array(
      z.object({
        provider: providerParam,
        sourceRef: z.string().trim().min(1).max(SOURCE_REF_MAX_LENGTH),
        label: z.string().trim().max(60).optional(),
      }),
    )
    .max(
      MAX_SOURCES_PER_LIST - 1,
      `A catalog can merge at most ${MAX_SOURCES_PER_LIST} lists.`,
    )
    .optional(),
});
const actionsBody = z.object({
  enabled: z.boolean(),
  providers: z.array(providerParam).max(PROVIDER_IDS.length),
});

/** A saved configuration: Lists and settings. */
export const configBody = z.object({
  rpdbApiKey: z.string().trim().optional(),
  /** Omitted by older clients: the saved source stays. */
  posterSource: z.enum(POSTER_SOURCES).optional(),
  lists: z.array(listBody).min(1).max(MAX_LISTS),
  actions: actionsBody.optional(),
  newTitles: z
    .object({
      enabled: z.boolean(),
      settings: newTitlesSettingsSchema.optional(),
    })
    .optional(),
});

/**
 * A new Account may start without Lists: Simkl and MDBList users connect
 * first (a Connection belongs to an Account), then pick their Source lists.
 */
export const createBody = configBody.extend({
  lists: z.array(listBody).max(MAX_LISTS),
});

type ListBody = z.infer<typeof listBody>;

/** A submitted configuration that cannot be saved; its message is shown. */
export class ConfigError extends Error {
  readonly status = 400;
}

/** The stored RPDB key: an empty one is no key. */
export function rpdbKey(value: string | undefined) {
  return value && value.length > 0 ? value : null;
}

/**
 * The poster source that a save sets; undefined keeps the saved one. A page
 * from before the poster source sends none: for it, as then, an RPDB key
 * means RPDB posters.
 */
export function savedPosterSource(body: {
  posterSource?: PosterSource;
  rpdbApiKey?: string;
}) {
  return body.posterSource ?? (rpdbKey(body.rpdbApiKey) ? "rpdb" : undefined);
}

async function normalizeSource(
  source: ListSource,
  access: {
    via: AddonAccess;
    connected: Set<ProviderId>;
    savedSources: Set<string>;
  },
) {
  const info = PROVIDERS[source.provider];
  if (info.availability !== "available") {
    throw new ConfigError(`${info.label} is not available yet.`);
  }
  let sourceRef = source.sourceRef;
  if (source.provider === "imdb") {
    if (sourceRef.startsWith("p.") && !isProviderEnabled("imdb")) {
      throw new ConfigError(
        "IMDb is temporarily unavailable. Please try again later.",
      );
    }
    try {
      sourceRef = await normalizeImdbUserId(sourceRef);
    } catch {
      throw new ConfigError(
        `Could not resolve the IMDb handle "${source.sourceRef}". Please check it and try again.`,
      );
    }
    if (
      !IMDB_WATCHLIST_SOURCE_ID_PATTERN.test(sourceRef) &&
      !IMDB_RATINGS_REF_PATTERN.test(sourceRef) &&
      !isChartId(sourceRef)
    ) {
      throw new ConfigError(`"${source.sourceRef}" is not a valid IMDb list.`);
    }
  }
  if (source.provider === "letterboxd") {
    if (
      sourceRef.startsWith("lbxshare/") ||
      sourceRef.startsWith("lbxshort/")
    ) {
      throw new ConfigError("Paste the Letterboxd share link again to add it.");
    }
  }
  if (sourceRequiresConnection(source.provider, sourceRef)) {
    if (access.via === "legacy") {
      throw new ConfigError(
        `${info.label} lists need your private Addon URL. Upgrade this install first.`,
      );
    }
    if (
      !access.connected.has(source.provider) &&
      !access.savedSources.has(sourceKey({ ...source, sourceRef }))
    ) {
      throw new ConfigError(`Connect your ${info.label} account first.`);
    }
  }
  return { ...source, sourceRef };
}

interface SubmittedSources {
  sources: ListSource[];
  kept: boolean;
}

function submittedSources(list: ListBody, saved: ConfigList | undefined) {
  const sameFirst =
    saved?.provider === list.provider && saved.sourceRef === list.sourceRef;
  return {
    sources: [
      {
        provider: list.provider,
        sourceRef: list.sourceRef,
        label: list.sourceLabel ?? (sameFirst ? saved.sourceLabel : undefined),
      },
      ...(list.mergedSources ?? saved?.mergedSources ?? []),
    ],
    kept: !list.mergedSources && !!list.id,
  } satisfies SubmittedSources;
}

/**
 * Check and normalize submitted Lists. Light on purpose: links were already
 * resolved when the user added them, so saving does not read every Source
 * list again. The Lists follow the rules of `accountListsProblem` (checked
 * after normalization, so IMDb `p.` handles are already `ur…` IDs), then
 * each one those of `listMergeProblem`. Throws ConfigError.
 */
export async function normalizeLists(
  lists: ListBody[],
  access: {
    via: AddonAccess;
    connected: Set<ProviderId>;
    /** Saved Lists, for the merged Source lists that a client omits. */
    saved: ConfigList[];
  },
) {
  const normalized: ListInput[] = [];
  const saved = new Map(access.saved.map((list) => [list.id, list]));
  const savedSources = new Set(
    access.saved.flatMap((list) => listSources(list).map(sourceKey)),
  );
  for (const [index, list] of lists.entries()) {
    const submitted = submittedSources(
      list,
      list.id ? saved.get(list.id) : undefined,
    );
    const sources: ListSource[] = [];
    for (const source of submitted.sources) {
      sources.push(await normalizeSource(source, { ...access, savedSources }));
    }
    const [first, ...mergedSources] = sources;
    normalized.push({
      id: list.id,
      provider: first.provider,
      sourceRef: first.sourceRef,
      catalogTitle: list.catalogTitle ?? "",
      sortOption: list.sortOption,
      displayMode: list.displayMode ?? "split",
      position: index,
      catalogSettings: list.catalogSettings,
      mergedSources,
      ...(first.label ? { sourceLabel: first.label } : {}),
      ...(submitted.kept ? { keptMergedSources: true } : {}),
    });
  }
  const problem = accountListsProblem(normalized);
  if (problem) throw new ConfigError(problem.message);
  for (const input of normalized) {
    const mergeProblem = listMergeProblem(input);
    if (mergeProblem) throw new ConfigError(mergeProblem);
  }
  return normalized;
}

/** The Providers that the Account has a Connection with. */
export async function connectedProviders(access: AccountAccess) {
  if (access.via !== "private") return new Set<ProviderId>();
  return new Set(
    (await listConnections(access.account.id)).map((c) => c.provider),
  );
}

/** The sync status of these Lists and the Account's Connections. */
export async function syncSnapshot(access: AccountAccess, lists: ConfigList[]) {
  const [statuses, connections, readQueue] = await Promise.all([
    getListSyncStatuses(lists),
    access.via === "private" ? listConnections(access.account.id) : [],
    getListReadQueue(lists.map((list) => list.id)),
  ]);
  return { ...statuses, connections, readQueue };
}

/**
 * What the configure page shows about these Lists: each one with its
 * available genres, their sync status with the Connections, and the "New
 * titles" summary.
 */
export async function configSnapshot(
  access: AccountAccess,
  lists: ConfigList[],
) {
  const [withGenres, sync, summary] = await Promise.all([
    withAvailableGenres(lists),
    syncSnapshot(access, lists),
    getNewTitlesSummary(access, lists),
  ]);
  return { lists: withGenres, sync, summary };
}
