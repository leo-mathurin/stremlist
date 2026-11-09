import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { SOURCE_LINK_MAX_LENGTH } from "@stremlist/shared/constants";
import {
  baseRoutes,
  routeResolve,
  saveButton,
  SAVE_NEW,
} from "./config-fixture";

// What the link check says about a Letterboxd link it cannot add. The backend
// answers are intercepted; the backend tests cover how each answer is made.

const PASTE = "Paste a link to a watchlist or list";

const missing = [
  {
    kind: "watchlist",
    link: "https://letterboxd.com/someon/watchlist/",
    message:
      "Letterboxd could not find this watchlist. Check the username in the link.",
  },
  {
    kind: "diary",
    link: "https://letterboxd.com/someon/diary/",
    message:
      "Letterboxd could not find this diary. Check the username in the link.",
  },
  {
    kind: "list",
    link: "https://letterboxd.com/someone/list/top-10/",
    message:
      "Letterboxd could not find this list. Check the link. For a private list, set it to Anyone with share link on Letterboxd and paste the share link.",
  },
  {
    kind: "share link",
    link: "https://letterboxd.com/someone/list/top-10/share/2OS5xaC1fJOBBvGv/",
    message:
      "This Letterboxd share link no longer works. Its owner turned off sharing or deleted the list. Ask them for a new share link.",
  },
];

for (const { kind, link, message } of missing) {
  test(`the link check explains a missing Letterboxd ${kind}`, async ({
    app,
    screen,
    browser,
  }) => {
    await baseRoutes(browser);
    const inputs = await routeResolve(browser, () => ({
      ok: false,
      reason: "not_found",
      provider: "letterboxd",
    }));
    await app.open("/configure");
    await screen.getByLabel(PASTE).fill(link);
    await screen.getByRole("button", "Add", { exact: true }).tap();
    await expect(screen.getByText(message)).toBeVisible();
    expect(inputs).toEqual([{ input: link }]);
    await expect(screen.getByText("No Lists yet")).toBeVisible();
    await expect(saveButton(screen, SAVE_NEW)).toBeDisabled();
  });
}

test("the link check refuses a link that is too long, without a request", async ({
  app,
  screen,
  browser,
}) => {
  await baseRoutes(browser);
  const inputs = await routeResolve(browser, () => ({
    ok: false,
    reason: "unavailable",
    provider: "letterboxd",
  }));
  const start = "https://letterboxd.com/someone/list/";
  const end = "/share/2OS5xaC1fJOBBvGv/";
  const link = `${start}${"a".repeat(SOURCE_LINK_MAX_LENGTH + 1 - start.length - end.length)}${end}`;
  await app.open("/configure");
  await screen.getByLabel(PASTE).fill(link);
  await screen.getByRole("button", "Add", { exact: true }).tap();
  await expect(
    screen.getByText(
      `This link is too long. Paste a link of at most ${SOURCE_LINK_MAX_LENGTH} characters.`,
    ),
  ).toBeVisible();
  expect(inputs).toEqual([]);
});
