import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import type { AccountConfigInput } from "@stremlist/shared/stremio.types";
import {
  SAVED,
  SAVED_WITH_CHANGES,
  accountId,
  backend,
  baseRoutes,
  configuration,
  parseBody,
  row,
  savedLists,
  toJson,
} from "./config-fixture";

// The List has no genre choices until a refresh brings them.
const list = { ...row, availableGenres: [] };

for (const editFilter of [false, true]) {
  test(`refresh during save ${editFilter ? "preserves a later filter edit" : "does not create unsaved changes"}`, async ({
    app,
    screen,
    browser,
  }) => {
    await baseRoutes(browser);
    let releaseSave = () => {};
    const responseGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const submissions: AccountConfigInput[] = [];
    await browser.route(`${backend}/${accountId}/config`, async (route) => {
      if (route.request.method === "GET") {
        await route.fulfill({
          json: { ...configuration, lastFetchedAt: null, lists: [list] },
        });
        return;
      }
      const submitted = parseBody<AccountConfigInput>(route);
      submissions.push(submitted);
      await responseGate;
      await route.fulfill({
        json: toJson({ ok: true, lists: savedLists(submitted, ["Drama"]) }),
      });
    });
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
    await screen.getByRole("button", "Settings for Test catalog").tap();
    await screen.getByRole("button", /Filters & extra catalogs/).tap();
    await expect(screen.getByLabel("Genre", { exact: true })).toBeDisabled();
    await screen.getByRole("button", "Save", { exact: true }).tap();
    await expect(screen.getByRole("button", "Saving")).toBeVisible();
    await screen.getByRole("button", "Refresh now").tap();
    // Genre availability confirms that React has committed the refresh result.
    await expect(screen.getByLabel("Genre", { exact: true })).toBeEnabled();
    if (editFilter) {
      await screen.getByLabel("Genre", { exact: true }).tap();
      await screen.getByRole("option", "Drama", { exact: true }).tap();
      await expect(screen.getByLabel("Genre", { exact: true })).toHaveText(
        "Drama",
      );
    }
    releaseSave();
    await expect(
      screen.getByText(editFilter ? SAVED_WITH_CHANGES : SAVED),
    ).toBeVisible();
    await screen.getByRole("button", "Save", { exact: true }).tap();
    await expect(screen.getByText(SAVED)).toBeVisible();
    expect(submissions).toHaveLength(2);
    expect(submissions[0].lists[0].catalogSettings).toEqual({});
    expect(submissions[1].lists[0].catalogSettings).toEqual(
      editFilter ? { genre: "Drama" } : {},
    );
    if (!editFilter) expect(submissions[1]).toEqual(submissions[0]);
  });
}
