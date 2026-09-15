import { z } from "zod";

export const catalogSettingsSchema = z.object({
  genre: z.string().trim().min(1).max(100).optional(),
  decade: z.number().int().min(1880).max(2100).multipleOf(10).optional(),
  maxRuntime: z.number().int().min(1).max(600).optional(),
  minRating: z.number().min(0).max(10).optional(),
  presets: z
    .array(z.enum(["short", "rated", "shuffle"]))
    .max(3)
    .refine(
      (values) => new Set(values).size === values.length,
      "Duplicate presets",
    )
    .optional(),
});
