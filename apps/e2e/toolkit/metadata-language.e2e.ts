import { test } from "@e2e-dev/web";
import type { Browser } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  SAVED,
  accountId,
  captureConfig,
  configuration,
  saveButton,
} from "./config.fixture";

const IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"><rect width="2" height="3"/></svg>';

async function routePreviewImages(browser: Browser) {
  await browser.route("https://image.tmdb.org/**", async (route) => {
    await route.fulfill({ body: IMAGE, contentType: "image/svg+xml" });
  });
}

test("language picker filters by ISO code, previews localized metadata, and saves", async ({
  app,
  browser,
  screen,
}) => {
  const submissions = await captureConfig(browser);
  await routePreviewImages(browser);
  await app.open(`/configure?account=${accountId}`);

  const combobox = screen.getByRole("combobox", "Language");
  await expect(combobox).toHaveText(/English/);
  await expect(combobox).not.toHaveText(/en-US/);

  await combobox.tap();
  await screen.getByLabel("Search language").fill("it-IT");
  await screen.getByRole("option", /Italiano/).tap();
  await expect(combobox).toHaveText(/Italiano/);
  await expect(
    screen.getByText(
      "Localized titles and descriptions from TMDB. When a title has no Italian translation, English shows.",
    ),
  ).toBeVisible();

  const preview = screen.getByRole("button", "Preview");
  await expect(preview).toHaveAttribute("aria-expanded", "false");
  await preview.tap();
  await expect(preview).toHaveAttribute("aria-expanded", "true");
  await expect(screen.getByText("Dune - Parte due")).toBeVisible();
  await expect(screen.getByText("In Stremio")).not.toBeVisible();

  await screen.getByRole("button", "Severance").tap();
  await expect(screen.getByText("Scissione")).toBeVisible();

  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED)).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({ metadataLanguage: "it-IT" });
});

test("Use Stremio's metadata updates the preview and saves cleanly", async ({
  app,
  browser,
  screen,
}) => {
  const submissions = await captureConfig(browser, {
    ...configuration,
    metadataLanguage: "fr-FR",
  });
  await routePreviewImages(browser);
  await app.open(`/configure?account=${accountId}`);

  const combobox = screen.getByRole("combobox", "Language");
  await expect(combobox).toHaveText(/Français/);
  await expect(saveButton(screen)).toHaveAttribute(
    "title",
    "No changes to save",
  );

  await combobox.tap();
  await screen.getByRole("option", "Use Stremio's metadata").tap();
  await expect(combobox).toHaveText(/Use Stremio's metadata/);

  await screen.getByRole("button", "Preview").tap();
  await expect(
    screen.getByText(
      "Filled by Stremio (Cinemeta or your TMDB addon) in your Stremio language.",
    ),
  ).toBeVisible();

  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED)).toBeVisible();
  expect(submissions[0]).toMatchObject({ metadataLanguage: "stremio" });
});
