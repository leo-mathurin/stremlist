import {
  ACCOUNT_KEY_PATTERN,
  BASE_MANIFEST,
  IMDB_USER_ID_PATTERN,
} from "@stremlist/shared/constants";
import { Hono } from "hono";
import { ensureLegacyAccount, resolveAccountKey } from "../services/accounts";
import { buildAccountManifest } from "../services/addon-manifest";

const manifest = new Hono();

function configurationRequired() {
  return {
    ...structuredClone(BASE_MANIFEST),
    behaviorHints: { configurable: true, configurationRequired: true },
  };
}

manifest.get("/manifest.json", (c) => c.json(configurationRequired()));

manifest.get("/:accountKey/manifest.json", async (c) => {
  const key = c.req.param("accountKey");
  if (!ACCOUNT_KEY_PATTERN.test(key)) {
    return c.json(configurationRequired(), 404);
  }

  try {
    let access = await resolveAccountKey(key);
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
