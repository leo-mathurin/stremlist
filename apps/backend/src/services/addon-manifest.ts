import { APP_DESCRIPTION, BASE_MANIFEST } from "@stremlist/shared/constants";
import type { StremioManifest } from "@stremlist/shared/stremio.types";
import { createHash } from "node:crypto";
import type { AccountAccess } from "./accounts";
import { getVisibleLists } from "./accounts";
import { actionProviders } from "./actions";
import { withAvailableGenres } from "./catalog-genres";
import { buildManifestCatalogs } from "./stremio-catalogs";
import { isTrackedNow } from "./watch/tracking";

/**
 * The manifest ID must stay stable per install, but it must not leak the
 * Account ID (the secret). Legacy installs keep their historic ID.
 */
function manifestId(access: AccountAccess, key: string): string {
  if (access.via === "legacy") return `com.stremlist.${key}`;
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return `com.stremlist.${digest}`;
}

/**
 * The manifest that Stremio installs for an Account: its catalogs from the
 * last save, and the `stream` resource when Actions or Watch tracking are
 * on. Watch tracking also asks Stremio Web for its `player` and `library`
 * events (ADR 0003). `key` is the Addon URL key that Stremio uses (the
 * Account ID or a Legacy alias).
 */
export async function buildAccountManifest(
  access: AccountAccess,
  key: string,
): Promise<StremioManifest> {
  const { account } = access;
  const lists = await getVisibleLists(access);
  const resources = [...BASE_MANIFEST.resources];
  if (access.via === "private") {
    const [actions, tracked] = await Promise.all([
      actionProviders(account),
      isTrackedNow(account.id),
    ]);
    const titles = { types: ["movie", "series"], idPrefixes: ["tt"] };
    if (actions.length > 0 || tracked) {
      resources.push({ name: "stream", ...titles });
    }
    if (tracked) {
      resources.push({ name: "player", ...titles });
      resources.push({ name: "library", ...titles });
    }
  }

  return {
    ...structuredClone(BASE_MANIFEST),
    id: manifestId(access, key),
    description: `${APP_DESCRIPTION}. Changelog: https://stremlist.com/changelog`,
    resources,
    catalogs: buildManifestCatalogs(await withAvailableGenres(lists), {
      newTitles: account.newTitlesCatalog,
    }),
    config: [
      {
        key: "rpdbApiKey",
        type: "password",
        title: "RPDB API Key (Optional)",
        default: account.rpdbApiKey ?? "",
      },
    ],
  };
}
