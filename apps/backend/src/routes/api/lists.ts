import { zValidator } from "@hono/zod-validator";
import {
  ACCOUNT_KEY_PATTERN,
  SOURCE_LINK_MAX_LENGTH,
} from "@stremlist/shared/constants";
import { CATALOG_PRESETS } from "@stremlist/shared/catalog-settings";
import { Hono } from "hono";
import { z } from "zod";
import { listBody } from "../../services/account-config";
import { resolveAccountKey } from "../../services/accounts";
import { previewCatalogTitles, previewList } from "../../services/list-preview";
import { resolveSourceLink } from "../../services/source-links";
import { accountKeyParam } from "./access";

const previewBody = listBody
  .pick({
    provider: true,
    sourceRef: true,
    mergedSources: true,
    sortOption: true,
    displayMode: true,
    catalogSettings: true,
  })
  .extend({
    accountKey: accountKeyParam.shape.accountKey.optional(),
    ticket: z.guid().optional(),
  });

async function previewConnection(accountKey: string | undefined) {
  const access = accountKey ? await resolveAccountKey(accountKey) : null;
  return access?.via === "private" ? access.account.id : null;
}

/** Source lists and Lists before they are saved. */
const lists = new Hono()
  .post(
    "/links/resolve",
    zValidator(
      "json",
      z.object({
        /** A longer link is refused in the answer ("too_long"), not here. */
        input: z
          .string()
          .trim()
          .min(1)
          .max(SOURCE_LINK_MAX_LENGTH * 4),
        accountKey: z.string().regex(ACCOUNT_KEY_PATTERN).optional(),
        /** The place in the Provider's queue from a queued answer. */
        ticket: z.guid().optional(),
      }),
    ),
    async (c) => {
      const { input, accountKey, ticket } = c.req.valid("json");
      const access = accountKey ? await resolveAccountKey(accountKey) : null;
      return c.json(await resolveSourceLink(input, access, ticket ?? null));
    },
  )

  .post("/lists/preview", zValidator("json", previewBody), async (c) => {
    const { accountKey, ticket, ...list } = c.req.valid("json");
    return c.json(
      await previewList({
        ...list,
        connectionAccountId: await previewConnection(accountKey),
        ticket: ticket ?? null,
      }),
    );
  })

  .post(
    "/lists/preview/titles",
    zValidator(
      "json",
      previewBody.extend({
        catalog: z.object({
          type: z.enum(["movie", "series"]),
          preset: z.enum(CATALOG_PRESETS.map((preset) => preset.id)).nullable(),
        }),
        offset: z.number().int().min(0).max(100_000),
      }),
    ),
    async (c) => {
      const { accountKey, ticket, ...request } = c.req.valid("json");
      return c.json(
        await previewCatalogTitles({
          ...request,
          connectionAccountId: await previewConnection(accountKey),
          ticket: ticket ?? null,
        }),
      );
    },
  );

export default lists;
