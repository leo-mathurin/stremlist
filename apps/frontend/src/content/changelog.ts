import { z } from "zod";
import versions from "./changelog.json" with { type: "json" };

const Versions = z.array(
  z.object({
    version: z.string(),
    date: z.string(),
    changes: z.array(
      z.object({
        type: z.enum(["enhancement", "bugfix", "performance", "security"]),
        label: z.string(),
        text: z.string(),
      }),
    ),
  }),
);

export const VERSIONS = Versions.parse(versions);
