import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_METADATA_LANGUAGE,
  filterLanguageOptions,
  findLanguageOption,
  formatEnglishName,
  formatLanguageName,
  isLocalizedLanguage,
  isMetadataLanguage,
} from "../metadata-language";

describe("metadata-language", () => {
  it("recognizes valid metadata languages and rejects unknown ones", () => {
    expect(isMetadataLanguage(DEFAULT_METADATA_LANGUAGE)).toBe(true);
    expect(isMetadataLanguage("stremio")).toBe(true);
    expect(isMetadataLanguage("it-IT")).toBe(true);
    expect(isMetadataLanguage("xx-XX")).toBe(false);
    expect(isMetadataLanguage(null)).toBe(false);
  });

  it("identifies non-English TMDB locales that require translation lookups", () => {
    expect(isLocalizedLanguage("en-US")).toBe(false);
    expect(isLocalizedLanguage("stremio")).toBe(false);
    expect(isLocalizedLanguage("it-IT")).toBe(true);
    expect(isLocalizedLanguage("fr-FR")).toBe(true);
  });

  it("formats native and English labels cleanly", () => {
    const english = findLanguageOption("en-US");
    const spanish = findLanguageOption("es-ES");
    const italian = findLanguageOption("it-IT");
    expect(formatLanguageName(english)).toBe("English");
    expect(formatEnglishName(english)).toBe("Default");
    expect(formatLanguageName(spanish)).toBe("Español (Spain)");
    expect(formatEnglishName(spanish)).toBe("Spanish, Spain");
    expect(formatLanguageName(italian)).toBe("Italiano");
    expect(formatEnglishName(italian)).toBe("Italian");
  });

  it("filters by native name, English name, code, or keyword", () => {
    expect(filterLanguageOptions("it-IT").map((o) => o.code)).toEqual([
      "it-IT",
    ]);
    expect(filterLanguageOptions("francais").map((o) => o.code)).toEqual([
      "fr-FR",
    ]);
    expect(filterLanguageOptions("portuguese").map((o) => o.code)).toEqual([
      "pt-BR",
      "pt-PT",
    ]);
    expect(filterLanguageOptions("   ").length).toBeGreaterThan(20);
  });
});
