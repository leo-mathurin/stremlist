import { zValidator } from "@hono/zod-validator";
import {
  ACCOUNT_KEY_PATTERN,
  SOURCE_LINK_MAX_LENGTH,
} from "@stremlist/shared/constants";
import { CATALOG_PRESETS } from "@stremlist/shared/catalog-settings";
import { MAX_SOURCES_PER_ACCOUNT } from "@stremlist/shared/list-merge";
import { Hono } from "hono";
import { z } from "zod";
import { listBody } from "../../services/account-config";
import { resolveAccountKey } from "../../services/accounts";
import { newTitlesSettingsSchema } from "../../services/catalog-settings";
import {
  previewCatalogTitles,
  previewDetectedCatalogTitles,
  previewDetectedList,
  previewList,
} from "../../services/list-preview";
import { resolveSourceLink } from "../../services/source-links";
import { accountKeyParam } from "./access";

const previewAccessFields = {
  accountKey: accountKeyParam.shape.accountKey.optional(),
  ticket: z.guid().optional(),
};
const sourcePreviewBody = listBody
  .pick({
    provider: true,
    sourceRef: true,
    mergedSources: true,
    sortOption: true,
    displayMode: true,
    catalogSettings: true,
  })
  .extend({ ...previewAccessFields, kind: z.undefined().optional() });
const newTitlesPreviewBody = newTitlesSettingsSchema
  .pick({ sortOption: true, displayMode: true, catalogSettings: true })
  .extend({
    ...previewAccessFields,
    kind: z.literal("new-titles"),
    sources: z
      .array(listBody.pick({ provider: true, sourceRef: true }))
      .max(MAX_SOURCES_PER_ACCOUNT)
      .optional(),
  });

const previewBody = z.union([sourcePreviewBody, newTitlesPreviewBody]);
const pageFields = {
  catalog: z.object({
    type: z.enum(["movie", "series"]),
    preset: z.enum(CATALOG_PRESETS.map((preset) => preset.id)).nullable(),
  }),
  offset: z.number().int().min(0).max(100_000),
};
const previewTitlesBody = z.union([
  sourcePreviewBody.extend(pageFields),
  newTitlesPreviewBody.extend(pageFields),
]);

async function previewAccess(accountKey: string | undefined) {
  return accountKey ? resolveAccountKey(accountKey) : null;
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
    const access = await previewAccess(accountKey);
    if (list.kind === "new-titles") {
      return c.json(await previewDetectedList(list, access));
    }
    return c.json(
      await previewList({
        ...list,
        connectionAccountId:
          access?.via === "private" ? access.account.id : null,
        ticket: ticket ?? null,
      }),
    );
  })

  .post(
    "/lists/preview/titles",
    zValidator("json", previewTitlesBody),
    async (c) => {
      const { accountKey, ticket, ...request } = c.req.valid("json");
      const access = await previewAccess(accountKey);
      if (request.kind === "new-titles") {
        return c.json(await previewDetectedCatalogTitles(request, access));
      }
      return c.json(
        await previewCatalogTitles({
          ...request,
          connectionAccountId:
            access?.via === "private" ? access.account.id : null,
          ticket: ticket ?? null,
        }),
      );
    },
  );

export default lists;
