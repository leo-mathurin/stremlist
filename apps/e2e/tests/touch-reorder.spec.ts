import { expect, test } from "@playwright/test";
import type { CDPSession, Locator, Page } from "@playwright/test";
import type { AccountConfigInput } from "@stremlist/shared/stremio.types";
import { BACKEND_URL, FRONTEND_URL } from "../env.js";
import { saveButton, SAVED_REINSTALL } from "../helpers/configure.js";
import {
  configuration,
  isConfigInput,
  providerStatus,
  row,
  savedLists,
} from "../toolkit/config-fixture.js";

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

function titles(page: Page) {
  return page.locator("[data-list-row] p[title]").allTextContents();
}

async function point(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Gesture target is not visible");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function touch(
  session: CDPSession,
  type: "touchStart" | "touchMove" | "touchEnd",
  position: { x: number; y: number },
) {
  await session.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: type === "touchEnd" ? [] : [position],
  });
}

test(
  "touch reorders without a long press, keeps scrolling outside the handle and saves positions",
  { tag: "@local" },
  async ({ page }) => {
    const config = {
      ...configuration,
      lists: [
        row,
        ...[2, 3, 4, 5].map((number) => ({
          ...row,
          id: `00000000-0000-4000-8000-00000000000${number}`,
          sourceRef: `ls9912345${number}`,
          catalogTitle: `Catalog ${number}`,
          position: number - 1,
        })),
      ],
    };
    const saves: AccountConfigInput[] = [];
    await page.route(`${BACKEND_URL}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/providers") {
        return route.fulfill({ json: providerStatus() });
      }
      if (path.endsWith("/config")) {
        if (route.request().method() === "GET") {
          return route.fulfill({ json: config });
        }
        const submitted: unknown = route.request().postDataJSON();
        if (!isConfigInput(submitted)) throw new Error("Invalid order save");
        saves.push(submitted);
        return route.fulfill({
          json: { ok: true, lists: savedLists(submitted) },
        });
      }
      if (path.endsWith("/sync-status")) {
        return route.fulfill({
          json: { syncStatus: config.syncStatus, connections: [] },
        });
      }
      if (path.endsWith("/watch-tracking")) {
        return route.fulfill({
          json: { stremioLinked: false, stremioTrakt: false, destinations: [] },
        });
      }
      throw new Error(`Unexpected touch fixture request: ${path}`);
    });
    await page.goto(`${FRONTEND_URL}/configure?account=${config.accountId}`);
    const handle = page.getByRole("button", {
      name: "Drag to reorder Test catalog",
      exact: true,
    });
    await handle.scrollIntoViewIfNeeded();
    const initial = [
      "Test catalog",
      "Catalog 2",
      "Catalog 3",
      "Catalog 4",
      "Catalog 5",
    ];
    await expect.poll(() => titles(page)).toEqual(initial);
    const start = await point(handle);
    await page.touchscreen.tap(start.x, start.y);
    await expect(saveButton(page)).toBeDisabled();

    const session = await page.context().newCDPSession(page);
    try {
      const content = await point(
        page.getByText("Test catalog", { exact: true }),
      );
      const scrollBefore = await page.evaluate(() => window.scrollY);
      await touch(session, "touchStart", content);
      await touch(session, "touchMove", { ...content, y: content.y - 20 });
      await touch(session, "touchMove", { ...content, y: content.y - 150 });
      await touch(session, "touchEnd", content);
      await expect
        .poll(() => page.evaluate(() => window.scrollY))
        .toBeGreaterThan(scrollBefore + 40);
      await expect.poll(() => titles(page)).toEqual(initial);
      await expect(saveButton(page)).toBeDisabled();

      const drag = async (target: string, direction: number) => {
        await handle.scrollIntoViewIfNeeded();
        const from = await point(handle);
        const to = await point(
          page.getByRole("button", {
            name: `Drag to reorder ${target}`,
            exact: true,
          }),
        );
        await touch(session, "touchStart", from);
        // No hold: moving more than 5px cancels the old 250ms touch delay.
        await touch(session, "touchMove", {
          ...from,
          y: from.y + direction * 10,
        });
        await expect(
          handle.locator("xpath=ancestor::*[@data-list-row]"),
        ).toHaveClass(/opacity-60/);
        await touch(session, "touchMove", {
          ...from,
          y: to.y + direction * 30,
        });
        await page.evaluate(() => new Promise(requestAnimationFrame));
        await touch(session, "touchEnd", to);
      };
      await drag("Catalog 2", 1);
      await expect
        .poll(() => titles(page))
        .toEqual([
          "Catalog 2",
          "Test catalog",
          "Catalog 3",
          "Catalog 4",
          "Catalog 5",
        ]);
      await drag("Catalog 2", -1);
      await expect.poll(() => titles(page)).toEqual(initial);
      await expect(saveButton(page)).toBeDisabled();
      await drag("Catalog 2", 1);
    } finally {
      await session.detach();
    }
    await saveButton(page).click();
    await expect(page.getByText(SAVED_REINSTALL)).toBeVisible();
    expect(
      saves[0].lists.map(({ catalogTitle, position }) => ({
        catalogTitle,
        position,
      })),
    ).toEqual([
      { catalogTitle: "Catalog 2", position: 0 },
      { catalogTitle: "Test catalog", position: 1 },
      { catalogTitle: "Catalog 3", position: 2 },
      { catalogTitle: "Catalog 4", position: 3 },
      { catalogTitle: "Catalog 5", position: 4 },
    ]);
  },
);
