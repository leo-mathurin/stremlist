import { NEW_TITLES_SORT_OPTIONS } from "@stremlist/shared/manifest-catalogs";
import { z } from "zod";

const genresSchema = z
  .array(z.string().trim().min(1).max(100))
  .max(100)
  .transform((genres) => (genres.length > 0 ? [...new Set(genres)] : undefined))
  .optional();

function withLegacyGenre(value: unknown) {
  if (typeof value !== "object" || value === null || !("genre" in value)) {
    return value;
  }
  const { genre, ...rest } = value;
  return genre === undefined || "genres" in rest
    ? rest
    : { ...rest, genres: [genre] };
}

const catalogSettingsObjectSchema = z.object({
  genres: genresSchema,
  excludedGenres: genresSchema,
  decade: z.number().int().min(1880).max(2100).multipleOf(10).optional(),
  maxRuntime: z.number().int().min(1).max(600).optional(),
  minRating: z.number().min(0).max(10).optional(),
  hideUnreleased: z.union([z.literal(true), z.literal("digital")]).optional(),
  presets: z
    .array(z.enum(["short", "rated", "shuffle"]))
    .max(3)
    .refine(
      (values) => new Set(values).size === values.length,
      "Duplicate presets",
    )
    .optional(),
});

export const catalogSettingsSchema = z.preprocess(
  withLegacyGenre,
  catalogSettingsObjectSchema,
);

export const newTitlesSettingsSchema = z.object({
  catalogTitle: z.string().trim().max(60),
  sortOption: z.enum(NEW_TITLES_SORT_OPTIONS.map(({ value }) => value)),
  displayMode: z.enum(["split", "movie", "series"]),
  position: z.number().int().min(0),
  catalogSettings: catalogSettingsSchema.optional(),
});
