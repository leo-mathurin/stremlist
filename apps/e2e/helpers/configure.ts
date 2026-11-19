import type { ProviderId } from "@stremlist/shared/providers";
import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { FRONTEND_URL } from "../env.js";

/** The label of the Save button before the first save creates the Account. */
export const SAVE_NEW = "Save";

/** The save message when Stremio needs no reinstall. */
export const SAVED = "Saved! Your catalogs will refresh with the new settings.";

/**
 * The save message when Stremio must read the saved changes: the reminder
 * then offers a Stremio update or a reinstall.
 */
export const SAVED_REINSTALL = "Saved! Choose how Stremio gets your changes.";
/** The same save for a member who chose "Always reinstall myself". */
export const SAVED_REINSTALL_BY_HAND =
  "Saved! Reinstall Stremlist in Stremio to see your changes.";

/**
 * The Save button at the top of the Lists column. The floating Save button
 * at the bottom has the same name and stays in the page while it is hidden,
 * so take the first one.
 */
export function saveButton(page: Page, name = "Save") {
  return page.getByRole("button", { name, exact: true }).first();
}

/** The configure page of an Account ID or a Legacy alias. */
export function configureUrl(accountKey: string) {
  return `${FRONTEND_URL}/configure?account=${accountKey}`;
}

/** Open the configure page of `accountKey` and wait for the List `title`. */
export async function openConfigure(
  page: Page,
  accountKey: string,
  title: string,
) {
  await page.goto(configureUrl(accountKey));
  await expect(page.getByText(title, { exact: true })).toBeVisible();
}

/**
 * Save the configure page: click `button` (the top Save button by default),
 * expect the save request to succeed and the page to show `message` (any
 * "Saved!" message by default).
 */
export async function saveConfigure(
  page: Page,
  options: { message?: string; button?: Locator } = {},
) {
  const response = page.waitForResponse(
    (res) => res.url().endsWith("/config") && res.request().method() === "POST",
  );
  await (options.button ?? saveButton(page)).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByText(options.message ?? "Saved!")).toBeVisible();
}

/**
 * Type `key` in the RPDB API key field. The field shows for RPDB posters
 * only: pick RPDB first when another source is chosen.
 */
export async function fillRpdbKey(page: Page, key: string) {
  const field = page.locator("#rpdb-api-key");
  if (!(await field.isVisible())) {
    await page.getByRole("combobox", { name: "Posters" }).click();
    await page.getByRole("option", { name: /^RPDB/ }).click();
  }
  await field.fill(key);
}

async function openQuickAdd(page: Page, provider: ProviderId) {
  const row = page.getByTestId(`quick-add-${provider}`);
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
}

/** Add the built-in IMDb chart `name` from Quick add. */
export async function addImdbChart(page: Page, name: string | RegExp) {
  await openQuickAdd(page, "imdb");
  await page.getByRole("button", { name }).click();
}
