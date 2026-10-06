import { zValidator } from "@hono/zod-validator";
import {
  ACCOUNT_KEY_PATTERN,
  DISPLAY_MODE_OPTIONS,
  SORT_OPTIONS,
} from "@stremlist/shared/constants";
import { PROVIDER_IDS } from "@stremlist/shared/providers";
import { Hono } from "hono";
import { z } from "zod";
import { resolveAccountKey } from "../services/accounts";
import { catalogSettingsSchema } from "../services/catalog-settings";
import { previewList } from "../services/list-preview";

const previewBody = z.object({
  /** The Account whose Connection the read may use; absent for a new setup. */
  accountKey: z.string().regex(ACCOUNT_KEY_PATTERN).optional(),
  provider: z.enum(PROVIDER_IDS),
  sourceRef: z.string().trim().min(1).max(300),
  sortOption: z.enum(
    SORT_OPTIONS.map((option) => option.value) as [string, ...string[]],
  ),
  displayMode: z
    .enum(
      DISPLAY_MODE_OPTIONS.map((option) => option.value) as [
        "split",
        ...("movie" | "series")[],
      ],
    )
    .default("split"),
  catalogSettings: catalogSettingsSchema.optional(),
});

/**
 * Preview the Catalogs of a List, saved or not: a sample of Titles for each
 * Catalog and the Unresolved entries of its Source list.
 */
const preview = new Hono().post(
  "/",
  zValidator("json", previewBody),
  async (c) => {
    const { accountKey, ...list } = c.req.valid("json");
    // Like `/links/resolve`, an unknown key previews public lists only.
    const access = accountKey ? await resolveAccountKey(accountKey) : null;
    return c.json(
      await previewList({
        ...list,
        // Only read when `allowConnection` is true.
        accountId: access?.account.id ?? "",
        // A Legacy alias can be guessed: it never reads through a Connection.
        allowConnection: access?.via === "private",
      }),
    );
  },
);

export default preview;
