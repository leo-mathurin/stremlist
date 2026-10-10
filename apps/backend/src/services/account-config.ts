import {
  DISPLAY_MODE_OPTIONS,
  IMDB_WATCHLIST_SOURCE_ID_PATTERN,
  SORT_OPTIONS,
} from "@stremlist/shared/constants";
import type { TitleType } from "@stremlist/shared/constants";
import { isChartId } from "@stremlist/shared/imdb-charts";
import type { ListSource } from "@stremlist/shared/list-merge";
import {
  MAX_LISTS,
  MAX_SOURCES_PER_LIST,
  accountListsProblem,
  listMergeProblem,
} from "@stremlist/shared/list-merge";
import type { ProviderId } from "@stremlist/shared/providers";
import {
  PROVIDER_IDS,
  PROVIDERS,
  sourceRequiresConnection,
} from "@stremlist/shared/providers";
import type {
  AccountSyncSnapshot,
  AddonAccess,
  ConfigList,
} from "@stremlist/shared/stremio.types";
import { z } from "zod";
import type { AccountAccess, ListInput } from "./accounts";
import { withAvailableGenres } from "./catalog-genres";
import { catalogSettingsSchema } from "./catalog-settings";
import { listConnections } from "./connections";
import { getNewTitlesSummary } from "./detections";
import { normalizeImdbUserId } from "./imdb-scraper";
import { getListSyncStatuses } from "./sync-status";

export const providerParam = z.enum(PROVIDER_IDS);

const sortOptionValues = SORT_OPTIONS.map((o) => o.value) as [
  string,
  ...string[],
];
const displayModeValues = DISPLAY_MODE_OPTIONS.map((o) => o.value) as [
  "split",
  ...TitleType[],
];

/** One List as the configure page submits it. */
export const listBody = z.object({
  id: z.string().uuid().optional(),
  provider: providerParam,
  sourceRef: z.string().trim().min(1).max(300),
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
        sourceRef: z.string().trim().min(1).max(300),
        label: z.string().trim().max(60).optional(),
      }),
    )
    .max(
      MAX_SOURCES_PER_LIST - 1,
      `A List can merge at most ${MAX_SOURCES_PER_LIST} Source lists.`,
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
  lists: z.array(listBody).min(1).max(MAX_LISTS),
  actions: actionsBody.optional(),
  newTitles: z.object({ enabled: z.boolean() }).optional(),
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
export function rpdbKey(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

function defaultTitle(index: number, total: number): string {
  return total <= 1 ? "" : String(index + 1);
}

/**
 * Check and normalize one Source list of a submitted List. IMDb `p.`
 * handles are turned into `ur…` IDs.
 */
async function normalizeSource(
  source: ListSource,
  access: { via: AddonAccess; connected: Set<ProviderId> },
): Promise<ListSource> {
  const info = PROVIDERS[source.provider];
  if (info.availability !== "available") {
    throw new ConfigError(`${info.label} is not available yet.`);
  }
  let sourceRef = source.sourceRef;
  if (source.provider === "imdb") {
    try {
      sourceRef = await normalizeImdbUserId(sourceRef);
    } catch {
      throw new ConfigError(
        `Could not resolve the IMDb handle "${source.sourceRef}". Please check it and try again.`,
      );
    }
    // The IMDb adapter treats any other ref as a watchlist user ID, so a
    // malformed one would be saved and fail on every catalog request.
    if (
      !IMDB_WATCHLIST_SOURCE_ID_PATTERN.test(sourceRef) &&
      !isChartId(sourceRef)
    ) {
      throw new ConfigError(`"${source.sourceRef}" is not a valid IMDb list.`);
    }
  }
  if (sourceRequiresConnection(source.provider, sourceRef)) {
    if (access.via === "legacy") {
      throw new ConfigError(
        `${info.label} lists need your private Addon URL. Upgrade this install first.`,
      );
    }
    if (!access.connected.has(source.provider)) {
      throw new ConfigError(`Connect your ${info.label} account first.`);
    }
  }
  return { ...source, sourceRef };
}

/**
 * The Source lists of a submitted List, its first one first. An omitted
 * `mergedSources` or `sourceLabel` keeps the saved one, so older clients do
 * not split a merged List or erase its label; the transaction then checks
 * that the kept Source lists did not change since this read (`kept`).
 */
function submittedSources(
  list: ListBody,
  saved: ConfigList | undefined,
): { sources: ListSource[]; kept: boolean } {
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
  };
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
): Promise<ListInput[]> {
  const normalized: ListInput[] = [];
  const saved = new Map(access.saved.map((list) => [list.id, list]));
  for (const [index, list] of lists.entries()) {
    const submitted = submittedSources(
      list,
      list.id ? saved.get(list.id) : undefined,
    );
    const sources: ListSource[] = [];
    for (const source of submitted.sources) {
      sources.push(await normalizeSource(source, access));
    }
    const [first, ...mergedSources] = sources;
    const input: ListInput = {
      id: list.id,
      provider: first.provider,
      sourceRef: first.sourceRef,
      catalogTitle:
        list.catalogTitle && list.catalogTitle.length > 0
          ? list.catalogTitle
          : defaultTitle(index, lists.length),
      sortOption: list.sortOption,
      displayMode: list.displayMode ?? "split",
      position: index,
      catalogSettings: list.catalogSettings,
      mergedSources,
      ...(first.label ? { sourceLabel: first.label } : {}),
      ...(submitted.kept ? { keptMergedSources: true } : {}),
    };
    normalized.push(input);
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
export async function connectedProviders(
  access: AccountAccess,
): Promise<Set<ProviderId>> {
  if (access.via !== "private") return new Set();
  return new Set(
    (await listConnections(access.account.id)).map((c) => c.provider),
  );
}

/** The sync status of these Lists and the Account's Connections. */
export async function syncSnapshot(
  access: AccountAccess,
  lists: ConfigList[],
): Promise<AccountSyncSnapshot> {
  const [statuses, connections] = await Promise.all([
    getListSyncStatuses(lists),
    access.via === "private" ? listConnections(access.account.id) : [],
  ]);
  return { ...statuses, connections };
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
