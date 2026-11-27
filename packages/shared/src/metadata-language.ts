/**
 * Supported TMDB locale codes for localized Title names and plot descriptions.
 * `en-US` is the default and matches the English metadata Stremlist always used.
 */
export const METADATA_LANGUAGE_CODES = [
  "en-US",
  "it-IT",
  "fr-FR",
  "es-ES",
  "es-MX",
  "de-DE",
  "pt-BR",
  "pt-PT",
  "nl-NL",
  "pl-PL",
  "ja-JP",
  "ko-KR",
  "tr-TR",
  "sv-SE",
  "da-DK",
  "nb-NO",
  "fi-FI",
  "cs-CZ",
  "ro-RO",
  "hu-HU",
  "el-GR",
  "uk-UA",
  "ar-SA",
  "zh-CN",
] as const;

export type MetadataLanguageCode = (typeof METADATA_LANGUAGE_CODES)[number];

/**
 * The language choice of an Account: a locale code for Stremlist metadata,
 * or `"stremio"` to omit plot descriptions so Stremio's own metadata addon
 * (Cinemeta or a TMDB addon) supplies them in the user's language.
 */
export const METADATA_LANGUAGES = [
  "stremio",
  ...METADATA_LANGUAGE_CODES,
] as const;

export type MetadataLanguage = (typeof METADATA_LANGUAGES)[number];

/** Non-English TMDB locales that need a translation lookup. */
export type LocalizedMetadataLanguage = Exclude<MetadataLanguageCode, "en-US">;

export const DEFAULT_METADATA_LANGUAGE: MetadataLanguage = "en-US";

export function isMetadataLanguage(value: unknown): value is MetadataLanguage {
  return METADATA_LANGUAGES.some((language) => language === value);
}

/** Whether `language` asks Stremlist to look up localized TMDB metadata. */
export function isLocalizedLanguage(
  language: MetadataLanguage,
): language is LocalizedMetadataLanguage {
  return language !== "en-US" && language !== "stremio";
}

export interface LanguageOption {
  code: MetadataLanguageCode;
  nativeName: string;
  englishName: string;
  region?: string;
  keywords?: string;
}

export const LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  {
    code: "en-US",
    nativeName: "English",
    englishName: "English",
    keywords: "default us uk",
  },
  {
    code: "it-IT",
    nativeName: "Italiano",
    englishName: "Italian",
    keywords: "italia",
  },
  {
    code: "fr-FR",
    nativeName: "Français",
    englishName: "French",
    keywords: "france francais",
  },
  {
    code: "es-ES",
    nativeName: "Español",
    englishName: "Spanish",
    region: "Spain",
    keywords: "espana castellano",
  },
  {
    code: "es-MX",
    nativeName: "Español",
    englishName: "Spanish",
    region: "Latin America",
    keywords: "mexico latam",
  },
  {
    code: "de-DE",
    nativeName: "Deutsch",
    englishName: "German",
    keywords: "germany",
  },
  {
    code: "pt-BR",
    nativeName: "Português",
    englishName: "Portuguese",
    region: "Brazil",
    keywords: "brasil brazilian",
  },
  {
    code: "pt-PT",
    nativeName: "Português",
    englishName: "Portuguese",
    region: "Portugal",
  },
  {
    code: "nl-NL",
    nativeName: "Nederlands",
    englishName: "Dutch",
    keywords: "netherlands belgie",
  },
  {
    code: "pl-PL",
    nativeName: "Polski",
    englishName: "Polish",
    keywords: "poland",
  },
  {
    code: "ja-JP",
    nativeName: "日本語",
    englishName: "Japanese",
    keywords: "nihongo japan",
  },
  {
    code: "ko-KR",
    nativeName: "한국어",
    englishName: "Korean",
    keywords: "hangugeo korea",
  },
  {
    code: "tr-TR",
    nativeName: "Türkçe",
    englishName: "Turkish",
    keywords: "turkce turkey",
  },
  {
    code: "sv-SE",
    nativeName: "Svenska",
    englishName: "Swedish",
  },
  {
    code: "da-DK",
    nativeName: "Dansk",
    englishName: "Danish",
  },
  {
    code: "nb-NO",
    nativeName: "Norsk",
    englishName: "Norwegian",
  },
  {
    code: "fi-FI",
    nativeName: "Suomi",
    englishName: "Finnish",
  },
  {
    code: "cs-CZ",
    nativeName: "Čeština",
    englishName: "Czech",
    keywords: "cestina",
  },
  {
    code: "ro-RO",
    nativeName: "Română",
    englishName: "Romanian",
    keywords: "romana",
  },
  {
    code: "hu-HU",
    nativeName: "Magyar",
    englishName: "Hungarian",
  },
  {
    code: "el-GR",
    nativeName: "Ελληνικά",
    englishName: "Greek",
    keywords: "ellinika",
  },
  {
    code: "uk-UA",
    nativeName: "Українська",
    englishName: "Ukrainian",
  },
  {
    code: "ar-SA",
    nativeName: "العربية",
    englishName: "Arabic",
  },
  {
    code: "zh-CN",
    nativeName: "简体中文",
    englishName: "Chinese",
    region: "Simplified",
    keywords: "mandarin zhongwen",
  },
];

export function findLanguageOption(code: MetadataLanguageCode) {
  return (
    LANGUAGE_OPTIONS.find((option) => option.code === code) ??
    LANGUAGE_OPTIONS[0]
  );
}

export function formatLanguageName(option: LanguageOption) {
  return option.region
    ? `${option.nativeName} (${option.region})`
    : option.nativeName;
}

export function formatEnglishName(option: LanguageOption) {
  if (option.code === "en-US") return "Default";
  return option.region
    ? `${option.englishName}, ${option.region}`
    : option.englishName;
}

export function filterLanguageOptions(query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return LANGUAGE_OPTIONS;
  return LANGUAGE_OPTIONS.filter((option) =>
    [
      option.nativeName,
      option.englishName,
      option.code,
      option.region ?? "",
      option.keywords ?? "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalized),
  );
}
