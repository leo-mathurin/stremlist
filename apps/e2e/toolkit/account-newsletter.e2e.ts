import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  accountId,
  backend,
  baseRoutes,
  configuration,
  fitConfigurePage,
  holdToasts,
  row,
  secondAccountId,
} from "./config-fixture";

test(
  "returning home and opening another Addon URL replaces the previous form",
  { tags: ["agent", "new-journeys"] },
  async ({ app, agent, browser, screen }) => {
    await fitConfigurePage(browser);
    await baseRoutes(browser);
    await browser.route(`${backend}/${accountId}/config`, async (route) => {
      await route.fulfill({ json: configuration });
    });
    await browser.route(
      `${backend}/${secondAccountId}/config`,
      async (route) => {
        await route.fulfill({
          json: {
            ...configuration,
            accountId: secondAccountId,
            lists: [
              {
                ...row,
                sourceRef: "ur99887766",
                catalogTitle: "Second account",
                catalogSettings: { genre: "Comedy" },
              },
            ],
          },
        });
      },
    );
    await app.open(`/configure?account=${accountId}`);
    await screen.getByRole("button", "Settings for Test catalog").tap();
    await screen.getByLabel("Catalog title").fill("Discarded draft");
    await screen.getByRole("link", "Stremlist home").tap();
    await expect(browser).toHaveURL("/");
    await agent.act(
      "On this home page, open my existing Stremlist by entering its Addon URL {url} in the form. Do not visit that URL directly.",
      {
        params: { url: `${backend}/${secondAccountId}/manifest.json` },
        maxModelCalls: 5,
      },
    );
    await expect(browser).toHaveURL(`/configure?account=${secondAccountId}`);
    await expect(screen.getByText("Second account")).toBeVisible();
    await screen.getByRole("button", "Settings for Second account").tap();
    await expect(screen.getByLabel("Catalog title")).toHaveValue(
      "Second account",
    );
    await screen.getByRole("button", /Filters & extra catalogs/).tap();
    await expect(
      screen.getByRole("combobox", "Genre", { exact: true }),
    ).toHaveText("Comedy");
    await expect(screen.getByText("Discarded draft")).not.toBeVisible();
  },
);

test(
  "newsletter retry keeps the email and accepts already-subscribed confirmation",
  { tags: ["agent", "new-journeys"] },
  async ({ app, agent, browser, screen }) => {
    await holdToasts(browser);
    let attempts = 0;
    await browser.route(`${backend}/newsletter/subscribe`, async (route) => {
      expect(JSON.parse(route.request.postData ?? "{}")).toEqual({
        email: "retry@example.test",
      });
      attempts++;
      await route.fulfill({
        status: attempts === 1 ? 503 : 200,
        json:
          attempts === 1
            ? { success: false, error: "Newsletter temporarily unavailable" }
            : {
                success: true,
                message:
                  "You're already subscribed! You'll be notified about new features and updates.",
              },
      });
    });
    await app.open("/");
    await screen.getByPlaceholder("your@email.com").fill("retry@example.test");
    await screen.getByRole("button", "Subscribe", { exact: true }).tap();
    await expect(
      screen.getByText("Newsletter temporarily unavailable"),
    ).toBeVisible();
    await expect(screen.getByPlaceholder("your@email.com")).toHaveValue(
      "retry@example.test",
    );
    await agent.act(
      "Retry the newsletter subscription using the email already in the form.",
      { maxModelCalls: 4 },
    );
    await expect(screen.getByText(/You're already subscribed!/)).toBeVisible();
    await expect(
      screen.getByText("Newsletter temporarily unavailable"),
    ).not.toBeVisible();
    await expect(screen.getByPlaceholder("your@email.com")).toHaveValue("");
    expect(attempts).toBe(2);
  },
);

test("newsletter pending request blocks duplicate submissions", async ({
  app,
  browser,
  screen,
}) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  await browser.route(`${backend}/newsletter/subscribe`, async (route) => {
    attempts++;
    await gate;
    await route.fulfill({
      json: { success: true, message: "Fixture subscription saved" },
    });
  });
  await app.open("/");
  await screen.getByPlaceholder("your@email.com").fill("pending@example.test");
  try {
    await screen.getByRole("button", "Subscribe", { exact: true }).tap();
    await expect(screen.getByRole("button", "Subscribing...")).toBeDisabled();
    expect(attempts).toBe(1);
  } finally {
    release();
  }
  await expect(screen.getByText("Fixture subscription saved")).toBeVisible();
  await expect(
    screen.getByRole("button", "Subscribe", { exact: true }),
  ).toBeEnabled();
  expect(attempts).toBe(1);
});
