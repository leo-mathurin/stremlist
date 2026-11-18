import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { STREMIO_WEB_URL } from "../env.js";

export function addonsDeepLink(manifestUrl: string) {
  return `${STREMIO_WEB_URL}/#/addons?addon=${encodeURIComponent(manifestUrl)}`;
}

export function discoverUrl(
  manifestUrl: string,
  type: "movie" | "series",
  catalogId: string,
) {
  return `${STREMIO_WEB_URL}/#/discover/${encodeURIComponent(manifestUrl)}/${type}/${encodeURIComponent(catalogId)}`;
}

/**
 * Dismiss the "install the desktop app" prompt if it is showing. Its "Install"
 * link would otherwise collide with the addon modal's Install button.
 */
export async function dismissDesktopAppPrompt(page: Page) {
  const dismiss = page.getByText("Don't show again", { exact: true });
  try {
    await dismiss.click({ timeout: 3_000 });
  } catch {}
}

/**
 * Open the addon deep link and complete the install through the modal.
 * Resolves once the modal is gone and the addon shows as installed.
 */
export async function installAddon(page: Page, manifestUrl: string) {
  await page.goto(addonsDeepLink(manifestUrl));
  await dismissDesktopAppPrompt(page);
  const installButton = page.getByText("Install", { exact: true }).last();
  await expect(installButton).toBeVisible();
  await installButton.click();
  await expect(
    page.getByText("Stremlist", { exact: true }).first(),
  ).toBeVisible();
}

/** Uninstall the addon from the Addons page, confirming in the modal. */
export async function uninstallAddon(page: Page, manifestUrl: string) {
  await page.goto(addonsDeepLink(manifestUrl));
  await dismissDesktopAppPrompt(page);
  const uninstallButton = page.getByText("Uninstall", { exact: true }).last();
  await expect(uninstallButton).toBeVisible();
  await uninstallButton.click();
}

/** Titles of the meta items currently rendered on a Discover page, in order. */
export async function discoverItemTitles(page: Page) {
  const links = page.locator('a[href^="#/detail/"][title]');
  await expect(links.first()).toBeVisible();
  return links.evaluateAll((elements) =>
    elements.map((el) => el.getAttribute("title") ?? ""),
  );
}
