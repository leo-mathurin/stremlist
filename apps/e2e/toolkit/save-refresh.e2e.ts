import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  chooseRpdb,
  SAVED,
  SAVED_WITH_CHANGES,
  accountId,
  backend,
  configuration,
  gatedSaves,
  openFilters,
  row,
  saveButton,
} from "./config-fixture";

const list = { ...row, availableGenres: [] };

for (const editFilter of [false, true]) {
  test(`refresh during save ${editFilter ? "preserves a later filter edit" : "does not create unsaved changes"}`, async ({
    app,
    screen,
    browser,
  }) => {
    const { submissions, release } = await gatedSaves(
      browser,
      { ...configuration, lastFetchedAt: null, lists: [list] },
      ["Drama"],
    );
    await browser.route(`${backend}/${accountId}/refresh`, async (route) => {
      await route.fulfill({
        json: {
          ok: true,
          refreshed: 1,
          failed: 0,
          total: 1,
          lastFetchedAt: new Date().toISOString(),
          cooldownSeconds: 60,
          lists: [{ ...list, availableGenres: ["Drama"] }],
        },
      });
    });

    await app.open(`/configure?account=${accountId}`);
    await openFilters(screen, browser);
    const genre = screen.getByLabel("Genre", { exact: true });
    await expect(genre).toBeDisabled();
    await chooseRpdb(screen);
    await screen.getByLabel(/^RPDB API key/).fill("e2e-synthetic-rpdb");
    await saveButton(screen).tap();
    await expect(saveButton(screen, "Saving")).toBeVisible();
    await screen.getByRole("button", "Refresh now").tap();
    await expect(genre).toBeEnabled();
    if (editFilter) {
      await genre.tap();
      await screen.getByRole("option", "Drama", { exact: true }).tap();
      await expect(genre).toHaveText("Drama");
    }
    release();
    await expect(
      screen.getByText(editFilter ? SAVED_WITH_CHANGES : SAVED),
    ).toBeVisible();
    expect(submissions[0].lists[0].catalogSettings).toEqual({});
    if (!editFilter) {
      await expect(saveButton(screen)).toBeDisabled();
      expect(submissions).toHaveLength(1);
      return;
    }
    await saveButton(screen).tap();
    await expect(screen.getByText(SAVED)).toBeVisible();
    expect(submissions).toHaveLength(2);
    expect(submissions[1].lists[0].catalogSettings).toEqual({ genre: "Drama" });
  });
}
