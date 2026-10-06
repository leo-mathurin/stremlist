import {
  ACCOUNT_KEY_PATTERN,
  ADDON_VERSION,
  APP_DESCRIPTION,
  BASE_MANIFEST,
  IMDB_USER_ID_PATTERN,
} from "@stremlist/shared/constants";
import { sourceRequiresConnection } from "@stremlist/shared/providers";
import type {
  StremioManifest,
  StremioResource,
} from "@stremlist/shared/stremio.types";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import type { AccountAccess } from "../services/accounts";
import {
  ensureLegacyAccount,
  getAccountLists,
  resolveAccountKey,
} from "../services/accounts";
import { actionProviders } from "../services/actions";
import { withAvailableGenres } from "../services/catalog-genres";
import { buildManifestCatalogs } from "../services/stremio-catalogs";

const manifest = new Hono();

function configurationRequired(): StremioManifest {
  return {
    ...structuredClone(BASE_MANIFEST),
    behaviorHints: { configurable: true, configurationRequired: true },
  };
}

/**
 * The manifest ID must stay stable per install, but it must not leak the
 * Account ID (the secret). Legacy installs keep their historic ID.
 */
function manifestId(access: AccountAccess, key: string): string {
  if (access.via === "legacy") return `com.stremlist.${key}`;
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return `com.stremlist.${digest}`;
}

// Base manifest: requires configuration.
manifest.get("/manifest.json", (c) => c.json(configurationRequired()));

manifest.get("/:accountKey/manifest.json", async (c) => {
  const key = c.req.param("accountKey");
  if (!ACCOUNT_KEY_PATTERN.test(key)) {
    return c.json(configurationRequired(), 400);
  }

  try {
    let access = await resolveAccountKey(key);
    // Old installs pointed Stremio at /ur…/manifest.json without saving first.
    if (!access && IMDB_USER_ID_PATTERN.test(key)) {
      access = await ensureLegacyAccount(key);
    }
    if (!access) return c.json(configurationRequired());

    const { account } = access;
    const lists = (await getAccountLists(account.id)).filter(
      (list) =>
        access.via === "private" ||
        !sourceRequiresConnection(list.provider, list.sourceRef),
    );
    const resources: (string | StremioResource)[] = [
      "catalog",
      { name: "meta", types: ["movie"], idPrefixes: ["tt"] },
    ];
    if (
      access.via === "private" &&
      (await actionProviders(account)).length > 0
    ) {
      resources.push({
        name: "stream",
        types: ["movie", "series"],
        idPrefixes: ["tt"],
      });
    }

    const userManifest: StremioManifest = {
      ...structuredClone(BASE_MANIFEST),
      id: manifestId(access, key),
      version: ADDON_VERSION,
      name: "Stremlist",
      description: `${APP_DESCRIPTION}. Changelog: https://stremlist.com/changelog`,
      resources,
      catalogs: buildManifestCatalogs(await withAvailableGenres(lists)),
      behaviorHints: { configurable: true, configurationRequired: false },
      config: [
        {
          key: "rpdbApiKey",
          type: "password",
          title: "RPDB API Key (Optional)",
          default: account.rpdbApiKey ?? "",
        },
      ],
    };
    return c.json(userManifest);
  } catch (error) {
    console.error(
      `Error serving manifest for ${key}:`,
      error instanceof Error ? error.message : error,
    );
    return c.json(configurationRequired());
  }
});

export default manifest;
