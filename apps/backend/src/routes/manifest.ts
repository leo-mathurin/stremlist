import {
  ACCOUNT_KEY_PATTERN,
  BASE_MANIFEST,
  IMDB_USER_ID_PATTERN,
} from "@stremlist/shared/constants";
import type { StremioManifest } from "@stremlist/shared/stremio.types";
import { Hono } from "hono";
import { ensureLegacyAccount, resolveAccountKey } from "../services/accounts";
import { buildAccountManifest } from "../services/addon-manifest";

const manifest = new Hono();

function configurationRequired(): StremioManifest {
  return {
    ...structuredClone(BASE_MANIFEST),
    behaviorHints: { configurable: true, configurationRequired: true },
  };
}

// Base manifest: requires configuration.
manifest.get("/manifest.json", (c) => c.json(configurationRequired()));

manifest.get("/:accountKey/manifest.json", async (c) => {
  const key = c.req.param("accountKey");
  // No install has such a key (v1 stored some junk keys): never look it up.
  if (!ACCOUNT_KEY_PATTERN.test(key)) {
    return c.json(configurationRequired(), 404);
  }

  try {
    let access = await resolveAccountKey(key);
    // Old installs pointed Stremio at /ur…/manifest.json without saving first.
    // Like v1 since 2026-09-01, only an IMDb user ID or a `p.` handle creates
    // an install; the other Legacy alias forms only find existing ones.
    if (!access && IMDB_USER_ID_PATTERN.test(key)) {
      access = await ensureLegacyAccount(key);
    }
    if (!access) return c.json(configurationRequired());

    return c.json(await buildAccountManifest(access, key));
  } catch (error) {
    console.error(
      `Error serving manifest for ${key}:`,
      error instanceof Error ? error.message : error,
    );
    return c.json(configurationRequired());
  }
});

export default manifest;
