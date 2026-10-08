import type { Page } from "@playwright/test";

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
