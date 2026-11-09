import { zValidator } from "@hono/zod-validator";
import {
  ACCOUNT_KEY_PATTERN,
  SOURCE_LINK_MAX_LENGTH,
} from "@stremlist/shared/constants";
import { Hono } from "hono";
import { z } from "zod";
import { listBody } from "../../services/account-config";
import { resolveAccountKey } from "../../services/accounts";
import { previewList } from "../../services/list-preview";
import { resolveSourceLink } from "../../services/source-links";
import { accountKeyParam } from "./access";

/** Source lists and Lists before they are saved. */
const lists = new Hono()
  // Detect the Provider behind a pasted link and check that it can be read.
  .post(
    "/links/resolve",
    zValidator(
      "json",
      z.object({
        // A longer link is refused in the answer ("too_long"), not here.
        input: z
          .string()
          .trim()
          .min(1)
          .max(SOURCE_LINK_MAX_LENGTH * 4),
        accountKey: z.string().regex(ACCOUNT_KEY_PATTERN).optional(),
        // The place in the Provider's queue from a queued answer.
        ticket: z.string().uuid().optional(),
      }),
    ),
    async (c) => {
      const { input, accountKey, ticket } = c.req.valid("json");
      // An unknown key resolves public Source lists only.
      const access = accountKey ? await resolveAccountKey(accountKey) : null;
      return c.json(await resolveSourceLink(input, access, ticket ?? null));
    },
  )

  // Preview the Catalogs of a List, saved or not: a sample of Titles for each
  // Catalog and the Unresolved entries of its Source lists. Writes nothing.
  .post(
    "/lists/preview",
    zValidator(
      "json",
      listBody
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
          // The place in the Provider's queue from a queued answer.
          ticket: z.string().uuid().optional(),
        }),
    ),
    async (c) => {
      const { accountKey, ticket, ...list } = c.req.valid("json");
      // Like `/links/resolve`, an unknown key previews public lists only. A
      // Legacy alias can be guessed: it never reads through a Connection.
      const access = accountKey ? await resolveAccountKey(accountKey) : null;
      return c.json(
        await previewList({
          ...list,
          connectionAccountId:
            access?.via === "private" ? access.account.id : null,
          ticket: ticket ?? null,
        }),
      );
    },
  );

export default lists;
