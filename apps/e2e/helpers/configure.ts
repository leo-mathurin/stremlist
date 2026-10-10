import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { FRONTEND_URL } from "../env.js";

/** The label of the Save button before the first save creates the Account. */
export const SAVE_NEW = "Save and get my Addon URL";

/** The save message when the saved changes need a reinstall in Stremio. */
export const SAVED_REINSTALL =
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
export function configureUrl(accountKey: string): string {
  return `${FRONTEND_URL}/configure?account=${accountKey}`;
}

/** Open the configure page of `accountKey` and wait for the List `title`. */
export async function openConfigure(
  page: Page,
  accountKey: string,
  title: string,
): Promise<void> {
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
): Promise<void> {
  const response = page.waitForResponse(
    (res) => res.url().endsWith("/config") && res.request().method() === "POST",
  );
  await (options.button ?? saveButton(page)).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByText(options.message ?? "Saved!")).toBeVisible();
}
