/**
 * Schemas of the rows that the in-memory tables hold, so a test reads a typed
 * row instead of asserting one.
 */
import type { Tables } from "@stremlist/shared/database";
import { z } from "zod";
import { jsonObject } from "./json";

export const accountRow = z.object({
  action_providers: z.array(z.string()),
  actions_enabled: z.boolean(),
  created_at: z.string(),
  id: z.string(),
  is_active: z.boolean(),
  last_cache_served_at: z.string().nullable(),
  last_fetched_at: z.string(),
  legacy_imdb_user_id: z.string().nullable(),
  new_titles_catalog: z.boolean(),
  prewarm_lease_token: z.string().nullable(),
  prewarm_locked_until: z.string(),
  prewarm_request_generation: z.number(),
  rpdb_api_key: z.string().nullable(),
}) satisfies z.ZodType<Tables<"accounts">>;

export const listRow = z.object({
  account_id: z.string(),
  catalog_settings: jsonObject,
  catalog_title: z.string(),
  created_at: z.string(),
  display_mode: z.string(),
  id: z.string(),
  merged_sources: jsonObject,
  position: z.number(),
  provider: z.string(),
  sort_option: z.string(),
  source_label: z.string().nullable(),
  source_ref: z.string(),
  updated_at: z.string(),
}) satisfies z.ZodType<Tables<"lists">>;

export const connectionRow = z.object({
  access_token: z.string(),
  account_id: z.string(),
  authorization_version: z.string(),
  created_at: z.string(),
  expires_at: z.string().nullable(),
  needs_renewal_since: z.string().nullable(),
  provider: z.string(),
  provider_username: z.string().nullable(),
  redirect_uri: z.string(),
  refresh_lease_token: z.string().nullable(),
  refresh_locked_until: z.string(),
  refresh_token: z.string().nullable(),
  scope: z.string().nullable(),
  updated_at: z.string(),
}) satisfies z.ZodType<Tables<"connections">>;
