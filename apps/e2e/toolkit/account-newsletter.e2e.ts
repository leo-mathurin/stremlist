import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  account,
  backend,
  configuration,
  row,
  titlePlaceholder,
} from "./config-fixture";

test(
  "returning home and selecting another account replaces the previous form",
  { tags: ["agent", "new-journeys"] },
  async ({ app, agent, browser, screen }) => {
    const second = "ur99887766";
    await browser.route(`${backend}/**`, async (route) => {
      const path = new URL(route.request.url).pathname;
      if (path === `/${account}/config`)
        await route.fulfill({ json: configuration });
      else if (path === `/${second}/config`)
        await route.fulfill({
          json: {
            ...configuration,
            watchlists: [
              {
                ...row,
                imdbUserId: second,
                catalogTitle: "Second account",
                catalogSettings: { genre: "Comedy" },
              },
            ],
          },
        });
      else if (path === "/stats")
        await route.fulfill({ json: { activeUsers: 2 } });
      else throw new Error(`Unexpected account request: ${path}`);
    });
    await app.open(`/configure?userId=${account}`);
    await screen.getByPlaceholder(titlePlaceholder).fill("Discarded draft");
    await screen.getByRole("link", /Back to Home/).tap();
    await expect(screen.getByText(`Welcome back, ${account}!`)).toBeVisible();
    await agent.act(
      "Change the IMDb account to {account}, then open its configuration.",
      { params: { account: second }, maxModelCalls: 7 },
    );
    await expect(browser).toHaveURL(`/configure?userId=${second}`);
    await expect(screen.getByPlaceholder(titlePlaceholder)).toHaveValue(
      "Second account",
    );
    await screen.getByRole("button", /Filters & extra catalogs/).tap();
    await expect(
      screen.getByRole("combobox", "Genre", { exact: true }),
    ).toHaveText("Comedy");
    await expect(screen.getByPlaceholder(titlePlaceholder)).not.toHaveValue(
      "Discarded draft",
    );
  },
);

test(
  "newsletter retry keeps the email and accepts already-subscribed confirmation",
  { tags: ["agent", "new-journeys"] },
  async ({ app, agent, browser, screen }) => {
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
