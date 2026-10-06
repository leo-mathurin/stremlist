import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  account,
  backend,
  configuration,
  captureConfig,
  titlePlaceholder,
} from "./config-fixture";

for (const failure of ["http", "network"] as const) {
  test(`refresh recovers from ${failure} failure without discarding unsaved edits`, async ({
    app,
    browser,
    screen,
  }) => {
    const submissions = await captureConfig(browser);
    let attempts = 0;
    await browser.route(`${backend}/${account}/refresh`, async (route) => {
      if (++attempts === 1) {
        if (failure === "network") await route.abort();
        else
          await route.fulfill({
            status: 503,
            json: { error: "Refresh service unavailable" },
          });
      } else
        await route.fulfill({
          json: {
            ok: true,
            refreshed: 1,
            failed: 0,
            total: 1,
            watchlists: configuration.watchlists,
            lastFetchedAt: new Date().toISOString(),
            cooldownSeconds: 60,
          },
        });
    });
    await app.open(`/configure?userId=${account}`);
    await screen.getByPlaceholder(titlePlaceholder).fill("Still editing");
    await screen.getByRole("button", "Refresh now").tap();
    await expect(
      screen.getByText(
        failure === "network"
          ? "Failed to fetch"
          : "Refresh service unavailable",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(screen.getByRole("button", "Refresh now")).toBeEnabled();
    await screen.getByRole("button", "Refresh now").tap();
    await expect(screen.getByRole("button", /Refresh in \d+s/)).toBeDisabled();
    await expect(
      screen.getByText(
        failure === "network"
          ? "Failed to fetch"
          : "Refresh service unavailable",
        { exact: true },
      ),
    ).not.toBeVisible();
    await expect(screen.getByPlaceholder(titlePlaceholder)).toHaveValue(
      "Still editing",
    );
    await screen.getByRole("button", "Save", { exact: true }).tap();
    await expect(
      screen.getByText(/Saved! Catalog structure changed/),
    ).toBeVisible();
    expect(submissions[0].watchlists[0].catalogTitle).toBe("Still editing");
    expect(attempts).toBe(2);
  });
}

test("server throttle starts a cooldown and expiry enables a later refresh", async ({
  app,
  browser,
  screen,
}) => {
  await captureConfig(browser);
  let attempts = 0;
  await browser.route(`${backend}/${account}/refresh`, async (route) => {
    attempts++;
    await route.fulfill({
      json: {
        ok: true,
        throttled: attempts === 1,
        refreshed: attempts === 1 ? 0 : 1,
        failed: 0,
        total: attempts === 1 ? 0 : 1,
        lastFetchedAt: new Date().toISOString(),
        cooldownSeconds: attempts === 1 ? 2 : 60,
      },
    });
  });
  await app.open(`/configure?userId=${account}`);
  await screen.getByRole("button", "Refresh now").tap();
  await expect(screen.getByRole("button", /Refresh in \d+s/)).toBeDisabled();
  expect(attempts).toBe(1);
  // Poll the visible state; no fixed sleep or synthetic Date patch.
  await expect(screen.getByRole("button", "Refresh now")).toBeEnabled();
  await screen.getByRole("button", "Refresh now").tap();
  await expect(screen.getByRole("button", /Refresh in \d+s/)).toBeDisabled();
  expect(attempts).toBe(2);
});
