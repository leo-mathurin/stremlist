import { IMDB_TITLE_ID_PATTERN } from "@stremlist/shared/constants";
import type { MetadataLanguage } from "@stremlist/shared/metadata-language";
import { isLocalizedLanguage } from "@stremlist/shared/metadata-language";
import type {
  StremioCatalogMeta,
  StremioMeta,
} from "@stremlist/shared/stremio.types";
import {
  findTranslations,
  type TranslatableTitle,
} from "../titles/title-translations";

const STREMIO_METADATA_BUDGET_MS = 2_000;
const DETECTION_PREFIX = /^(Detected by Stremlist on [^\n]+)(?:\n\n|$)/u;
const LINK_BACK_SUFFIX =
  /(?:^|\n\n)(More on [^\n:]+: \S+(?:\n\nMore on [^\n:]+: \S+)*)$/u;

/** The metadata language setting of an Account. */
export interface MetadataSettings {
  metadataLanguage: MetadataLanguage;
}

function omitDescription(meta: StremioMeta) {
  const copy: StremioCatalogMeta = { ...meta };
  delete copy.description;
  return copy;
}

/**
 * Replace only the plot summary inside `original`, keeping any New titles
 * detection prefix and any Provider link-back suffix.
 */
export function localizeDescription(original: string, translatedPlot: string) {
  const prefix = DETECTION_PREFIX.exec(original)?.[1];
  const suffix = LINK_BACK_SUFFIX.exec(original)?.[1];
  return [prefix, translatedPlot, suffix].filter(Boolean).join("\n\n");
}

/**
 * Localized Title names for `settings`, keyed by IMDb ID. Empty unless the
 * Account uses a localized TMDB language.
 */
export async function localizedTitlesForAccount(
  metas: TranslatableTitle[],
  settings: MetadataSettings,
) {
  const names = new Map<string, string>();
  if (!isLocalizedLanguage(settings.metadataLanguage) || metas.length === 0) {
    return names;
  }
  const found = await findTranslations(settings.metadataLanguage, metas, {
    budgetMs: STREMIO_METADATA_BUDGET_MS,
  });
  for (const [id, translation] of found) {
    if (translation.title) names.set(id, translation.title);
  }
  return names;
}

/**
 * Apply the Account's metadata language choice to the Titles Stremio receives:
 * - `en-US`: keep the cached English metadata untouched.
 * - `stremio`: omit `description` on IMDb Titles so catalog previews omit the
 *   plot and the title detail page uses an available metadata addon.
 * - Any other supported locale: apply TMDB localized titles and plot summaries,
 *   falling back to English when a Title has no translation yet.
 */
export async function withAccountMetadata<T extends StremioMeta>(
  metas: T[],
  settings: MetadataSettings,
) {
  if (settings.metadataLanguage === "en-US") {
    return metas as StremioCatalogMeta[];
  }
  if (settings.metadataLanguage === "stremio") {
    return metas.map((meta) =>
      IMDB_TITLE_ID_PATTERN.test(meta.id) ? omitDescription(meta) : meta,
    );
  }
  if (!isLocalizedLanguage(settings.metadataLanguage)) return metas;

  const found = await findTranslations(settings.metadataLanguage, metas, {
    budgetMs: STREMIO_METADATA_BUDGET_MS,
  });
  return metas.map((meta) => {
    const translation = found.get(meta.id);
    if (!translation) return meta;
    return {
      ...meta,
      name: translation.title ?? meta.name,
      description: translation.description
        ? localizeDescription(meta.description, translation.description)
        : meta.description,
    };
  });
}
