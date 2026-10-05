import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import type {
  ConfigWatchlist,
  UserConfigUpdatePayload,
} from "@stremlist/shared/stremio.types";

const userId = "ur99123456";
const watchlist = {
  id: "a0429945-78b2-4736-9b1a-0a4b546cc867",
  imdbUserId: userId,
  catalogTitle: "Test catalog",
  sortOption: "added_at-asc",
  displayMode: "split",
  position: 0,
  catalogSettings: {},
  availableGenres: [],
} satisfies ConfigWatchlist;

for (const editFilter of [false, true]) {
  test(`refresh during save ${editFilter ? "preserves a later filter edit" : "does not create unsaved changes"}`, async ({
    app,
    screen,
    browser,
  }) => {
    let releaseSave = () => {};
    const responseGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const submissions: UserConfigUpdatePayload[] = [];
    await browser.route("http://127.0.0.1:4314/**", async (route) => {
      const { pathname } = new URL(route.request.url);
      if (route.request.method === "GET" && pathname === `/${userId}/config`) {
        await route.fulfill({
          json: {
            rpdbApiKey: "",
            lastFetchedAt: null,
            cooldownSeconds: 60,
            watchlists: [watchlist],
          },
        });
      } else if (
        route.request.method === "POST" &&
        pathname === `/${userId}/config`
      ) {
        const submitted: UserConfigUpdatePayload = JSON.parse(
          route.request.postData ?? "{}",
        );
        submissions.push(submitted);
        await responseGate;
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            watchlists: submitted.watchlists.map((row) => ({
              ...row,
              availableGenres: ["Drama"],
            })),
          }),
        });
      } else if (
        route.request.method === "POST" &&
        pathname === `/${userId}/refresh`
      ) {
        await route.fulfill({
          json: {
            ok: true,
            refreshed: 1,
            failed: 0,
            total: 1,
            lastFetchedAt: new Date().toISOString(),
            cooldownSeconds: 60,
            watchlists: [{ ...watchlist, availableGenres: ["Drama"] }],
          },
        });
      } else {
        throw new Error(
          `Unexpected test API request: ${route.request.method} ${pathname}`,
        );
      }
    });

    await app.open(`/configure?userId=${userId}`);
    await screen.getByRole("button", /Filters & extra catalogs/).tap();
    await expect(screen.getByLabel("Genre", { exact: true })).toBeDisabled();
    await screen.getByRole("button", "Save", { exact: true }).tap();
    await expect(screen.getByRole("button", "Saving...")).toBeVisible();
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
      screen.getByText(
        editFilter
          ? "Saved submitted settings. You have unsaved changes; save again to apply them."
          : "Saved! Your catalogs will be refreshed with the new settings.",
      ),
    ).toBeVisible();
    await screen.getByRole("button", "Save", { exact: true }).tap();
    await expect(
      screen.getByText(
        "Saved! Your catalogs will be refreshed with the new settings.",
      ),
    ).toBeVisible();
    expect(submissions).toHaveLength(2);
    expect(submissions[0].watchlists[0].catalogSettings).toEqual({});
    expect(submissions[1].watchlists[0].catalogSettings).toEqual(
      editFilter ? { genre: "Drama" } : {},
    );
    if (!editFilter) expect(submissions[1]).toEqual(submissions[0]);
  });
}
