import { BASE_MANIFEST, ADDON_VERSION } from "@stremlist/shared";
import type { StremioManifest } from "@stremlist/shared";
import { Hono } from "hono";
import { buildManifestCatalogs } from "../services/stremio-catalogs";
import {
  ensureUser,
  getUserWatchlists,
  getUserRpdbApiKey,
} from "../services/user";

const manifest = new Hono();

// Base manifest — requires configuration (no userId)
manifest.get("/manifest.json", (c) => {
  console.log("Serving base manifest (requires configuration)");

  const baseManifest: StremioManifest = {
    ...structuredClone(BASE_MANIFEST),
    behaviorHints: {
      configurable: true,
      configurationRequired: true,
    },
  };

  return c.json(baseManifest);
});

// User-specific manifest
manifest.get("/:userId/manifest.json", async (c) => {
  const userId = c.req.param("userId");
  console.log(`Serving user-specific manifest for: ${userId}`);

  try {
    await ensureUser(userId);
    const savedRpdbApiKey = await getUserRpdbApiKey(userId);
    const watchlists = await getUserWatchlists(userId);

    const userManifest: StremioManifest = {
      ...structuredClone(BASE_MANIFEST),
      id: `com.stremlist.${userId}`,
      version: ADDON_VERSION,
      name: "Stremlist",
      description: `Your IMDb Watchlist for user ${userId}. See changelog at https://stremlist.com/changelog`,
      catalogs: buildManifestCatalogs(watchlists),
      behaviorHints: {
        configurable: true,
        configurationRequired: false,
      },
      config: [
        {
          key: "rpdbApiKey",
          type: "password",
          title: "RPDB API Key (Optional)",
          default: savedRpdbApiKey ?? "",
        },
      ],
    };

    return c.json(userManifest);
  } catch (err) {
    console.error(
      `Error serving manifest for ${userId}:`,
      (err as Error).message,
    );

    const fallback: StremioManifest = {
      ...structuredClone(BASE_MANIFEST),
      behaviorHints: {
        configurable: true,
        configurationRequired: true,
      },
    };

    return c.json(fallback);
  }
});

export default manifest;
