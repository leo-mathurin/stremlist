import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { STREMIO_WEB_URL } from "../env.js";

// Page helpers for the hosted Stremio Web app (web.stremio.com). The app runs
// in anonymous/local mode: a fresh browser context has no account and stores
// the addon collection in localStorage, so tests are fully isolated.

export function addonsDeepLink(manifestUrl: string): string {
  return `${STREMIO_WEB_URL}/#/addons?addon=${encodeURIComponent(manifestUrl)}`;
}

export function discoverUrl(
  manifestUrl: string,
  type: "movie" | "series",
  catalogId: string,
): string {
  return `${STREMIO_WEB_URL}/#/discover/${encodeURIComponent(manifestUrl)}/${type}/${encodeURIComponent(catalogId)}`;
}

export function detailUrl(type: "movie" | "series", metaId: string): string {
  return `${STREMIO_WEB_URL}/#/detail/${type}/${metaId}/${metaId}`;
}

/**
 * Dismiss the "install the desktop app" prompt if it is showing. Its "Install"
 * link would otherwise collide with the addon modal's Install button.
 */
export async function dismissDesktopAppPrompt(page: Page): Promise<void> {
  const dismiss = page.getByText("Don't show again", { exact: true });
  try {
    await dismiss.click({ timeout: 3_000 });
  } catch {
    // Prompt not shown — nothing to do.
  }
}

/**
 * Open the addon deep link and complete the install through the modal.
 * Resolves once the modal is gone and the addon shows as installed.
 */
export async function installAddon(
  page: Page,
  manifestUrl: string,
): Promise<void> {
  await page.goto(addonsDeepLink(manifestUrl));
  await dismissDesktopAppPrompt(page);
  const installButton = page.getByText("Install", { exact: true }).last();
  await expect(installButton).toBeVisible();
  await installButton.click();
  // The modal closes on success; "Uninstall"/"Configure" appear on the card.
  await expect(
    page.getByText("Stremlist", { exact: true }).first(),
  ).toBeVisible();
}

/** Uninstall the addon from the Addons page, confirming in the modal. */
export async function uninstallAddon(
  page: Page,
  manifestUrl: string,
): Promise<void> {
  await page.goto(addonsDeepLink(manifestUrl));
  await dismissDesktopAppPrompt(page);
  const uninstallButton = page.getByText("Uninstall", { exact: true }).last();
  await expect(uninstallButton).toBeVisible();
  await uninstallButton.click();
}

/** Titles of the meta items currently rendered on a Discover page, in order. */
export async function discoverItemTitles(page: Page): Promise<string[]> {
  const links = page.locator('a[href^="#/detail/"][title]');
  await expect(links.first()).toBeVisible();
  return links.evaluateAll((elements) =>
    elements.map((el) => el.getAttribute("title") ?? ""),
  );
}
