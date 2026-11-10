import { test } from "@e2e-dev/web";
import type { Browser, WebRoute } from "@e2e-dev/web";
import { expect } from "e2e";
import type { Screen } from "e2e";
import {
  SAVED,
  SAVED_REINSTALL,
  accountId,
  backend,
  captureConfig,
  configuration,
  gatedSaves,
  holdToasts,
  saveButton,
  toJson,
} from "./config-fixture";

// Updating the installed Stremlist through a linked Stremio account, and the
// manual reinstall that stays available. Stremio's code page and API are
// answered here, in the browser, as they are called from the browser in
// production; lib/stremio-sync is unit-tested against the same answers.

const ADDON_URL = `${backend}/${accountId}/manifest.json`;
const LINK = "https://link.stremio.com/E2E1";
const SESSION = "e2e-stremio-session";
const EMAIL = "member@example.com";
const CONNECTION_KEY = "stremlist:stremio-connection";
const MANUAL_KEY = "stremlist:stremio-manual";

const TOGGLE = "Show newly detected titles";
const NEEDS_REINSTALL = "These changes need a reinstall.";
const CHOICE = "Update Stremio with your changes";
const UPDATING_SAVE = "Saved! Stremlist is updating Stremio.";
const UPDATED = "Stremio updated.";
const WAITING = "Confirm in the Stremio tab";

interface Addon {
  transportUrl: string;
  manifest: { id: string; name: string; catalogs?: object[] };
  flags?: object;
}

const cinemeta: Addon = {
  transportUrl: "https://v3-cinemeta.strem.io/manifest.json",
  manifest: { id: "com.linvo.cinemeta", name: "Cinemeta" },
  flags: { official: true, protected: true },
};
const torrentio: Addon = {
  transportUrl: "https://torrentio.strem.fun/manifest.json",
  manifest: { id: "com.stremio.torrentio.addon", name: "Torrentio" },
};
const installedManifest = {
  id: `com.stremlist.${accountId}`,
  name: "Stremlist",
  catalogs: [{ id: "watchlist", type: "movie", name: "Test catalog" }],
};
/** What the Addon URL serves after the save: one more catalog. */
const servedManifest = {
  ...installedManifest,
  catalogs: [
    { id: "new-titles-movie", type: "movie", name: "New titles" },
    ...installedManifest.catalogs,
  ],
};
const installed: Addon = {
  transportUrl: ADDON_URL,
  manifest: installedManifest,
  flags: {},
};

type Failure = "down" | "signed-out" | null;

/**
 * A Stremio account in memory: its addon collection, the code page, and the
 * Addon URL's manifest, which the test switches when it saves. The test approves the code and breaks Stremio at
 * will; every API call is recorded by method.
 */
async function routeStremio(
  browser: Browser,
  collection: Addon[] = [cinemeta, installed, torrentio],
  served: Addon["manifest"] = installedManifest,
) {
  const stremio = {
    collection: structuredClone(collection),
    /** What the Addon URL serves: the backend's manifest of the last save. */
    served,
    approved: false,
    failure: null as Failure,
    calls: [] as string[],
  };
  await browser.route(ADDON_URL, async (route) => {
    await route.fulfill({ json: toJson(stremio.served) });
  });
  await browser.route("https://link.stremio.com/**", async (route) => {
    const { pathname } = new URL(route.request.url);
    stremio.calls.push(pathname);
    if (pathname.endsWith("/create")) {
      await route.fulfill({
        json: { result: { success: true, code: "E2E1", link: LINK } },
      });
    } else if (stremio.approved) {
      await route.fulfill({
        json: { result: { success: true, authKey: SESSION } },
      });
    } else {
      await route.fulfill({
        json: { error: { code: 101, message: "Invalid or expired token" } },
      });
    }
  });
  await browser.route("https://api.strem.io/api/**", async (route) => {
    const method = new URL(route.request.url).pathname.split("/").at(-1)!;
    stremio.calls.push(method);
    if (stremio.failure === "down") return route.abort();
    const body = JSON.parse(route.request.postData ?? "{}") as {
      authKey?: string;
      addons?: Addon[];
    };
    if (stremio.failure === "signed-out" || body.authKey !== SESSION) {
      return route.fulfill({
        json: { error: { code: 1, message: "Session does not exist" } },
      });
    }
    await answer(route, method, body.addons);
  });

  async function answer(route: WebRoute, method: string, addons?: Addon[]) {
    if (method === "getUser") {
      await route.fulfill({ json: { result: { email: EMAIL } } });
    } else if (method === "addonCollectionGet") {
      await route.fulfill({
        json: toJson({ result: { addons: stremio.collection } }),
      });
    } else if (method === "addonCollectionSet") {
      stremio.collection = structuredClone(addons ?? []);
      await route.fulfill({ json: { result: { success: true } } });
    } else {
      throw new Error(`Unexpected Stremio API call: ${method}`);
    }
  }

  return stremio;
}

/**
 * Records the Stremio tab instead of opening it, lets the test move the
 * clock forward, and starts with a linked account or a remembered manual
 * choice when asked.
 */
async function preparePage(
  browser: Browser,
  start: { linked?: boolean; manual?: boolean } = {},
) {
  await browser.addInitScript(
    ({ linked, manual, connectionKey, manualKey, session, email }) => {
      const page = window as unknown as {
        e2eTabs: { location: { href: string }; opener: unknown }[];
        e2eClockOffset: number;
      };
      page.e2eTabs = [];
      page.e2eClockOffset = 0;
      const now = Date.now.bind(Date);
      Date.now = () => now() + page.e2eClockOffset;
      window.open = () => {
        const tab = { location: { href: "" }, opener: window, close() {} };
        page.e2eTabs.push(tab);
        return tab as unknown as Window;
      };
      if (linked) {
        localStorage.setItem(
          connectionKey,
          JSON.stringify({ authKey: session, email }),
        );
      }
      if (manual) localStorage.setItem(manualKey, "1");
    },
    {
      linked: !!start.linked,
      manual: !!start.manual,
      connectionKey: CONNECTION_KEY,
      manualKey: MANUAL_KEY,
      session: SESSION,
      email: EMAIL,
    },
  );
}

/** Moves the page clock `ms` ahead of real time (0 to undo). */
function setClock(browser: Browser, ms: number) {
  return browser.evaluate((offset) => {
    (window as unknown as { e2eClockOffset: number }).e2eClockOffset = offset;
    return offset;
  }, ms);
}

/** The address the Stremio tab was sent to, or null. */
function stremioTab(browser: Browser) {
  return browser.evaluate(() => {
    const tabs = (
      window as unknown as { e2eTabs: { location: { href: string } }[] }
    ).e2eTabs;
    return tabs.at(-1)?.location.href ?? null;
  });
}

function storedConnection(browser: Browser) {
  return browser.evaluate((key) => localStorage.getItem(key), CONNECTION_KEY);
}

/** Turns on the New titles catalog: two more catalogs in the manifest. */
async function changeCatalogs(screen: Screen) {
  await screen.getByRole("checkbox", TOGGLE).tap();
}

async function openConfigure(
  app: { open(path: string): Promise<void> },
  screen: Screen,
) {
  await app.open(`/configure?account=${accountId}`);
  await expect(screen.getByRole("checkbox", TOGGLE)).toBeVisible();
}

function stremlistEntry(collection: Addon[]) {
  return collection.find((addon) => addon.transportUrl === ADDON_URL);
}

test("a catalog save offers both ways, and linking Stremio updates the install", async ({
  app,
  screen,
  browser,
}) => {
  await holdToasts(browser);
  await preparePage(browser);
  await captureConfig(browser);
  const stremio = await routeStremio(browser);
  await openConfigure(app, screen);

  await changeCatalogs(screen);
  await expect(screen.getByText(NEEDS_REINSTALL)).toBeVisible();
  stremio.served = servedManifest;
  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  await expect(screen.getByText(CHOICE)).toBeVisible();
  await expect(screen.getByText("Recommended", { exact: true })).toBeVisible();
  await expect(
    screen.getByRole("button", "I'll reinstall myself"),
  ).toBeVisible();
  // Nothing reaches Stremio before the member chooses.
  expect(stremio.calls).toEqual([]);

  await screen.getByRole("button", "Update it for me").tap();
  await expect(screen.getByText(WAITING)).toBeVisible();
  await expect.poll(() => stremioTab(browser)).toBe(LINK);
  await expect(screen.getByRole("link", "Open Stremio again")).toHaveAttribute(
    "href",
    LINK,
  );

  stremio.approved = true;
  await expect(screen.getByText(UPDATED)).toBeVisible({ timeout: 15_000 });
  await expect(screen.getByText(CHOICE)).toHaveCount(0);
  // Only the Stremlist entry changed, in place, with the saved catalogs.
  expect(stremio.collection).toEqual([
    cinemeta,
    { ...installed, manifest: servedManifest },
    torrentio,
  ]);
  expect(JSON.parse((await storedConnection(browser)) ?? "{}")).toEqual({
    authKey: SESSION,
    email: EMAIL,
  });

  // The link survives a reload; Stremio already has the setup, so the check
  // on load writes nothing.
  const writes = stremio.calls.filter((c) => c === "addonCollectionSet");
  await browser.reload();
  await expect(
    screen.getByText("Stremio updates automatically", { exact: false }),
  ).toBeVisible();
  await expect(screen.getByText("me•••@example.com")).toBeVisible();
  await expect
    .poll(() => stremio.calls.filter((c) => c === "addonCollectionGet").length)
    .toBeGreaterThan(2);
  expect(stremio.calls.filter((c) => c === "addonCollectionSet")).toEqual(
    writes,
  );
});

test("reinstalling by hand stays available and can become the default", async ({
  app,
  screen,
  browser,
}) => {
  await preparePage(browser);
  await captureConfig(browser);
  const stremio = await routeStremio(browser);
  await openConfigure(app, screen);

  await changeCatalogs(screen);
  await saveButton(screen).tap();
  await screen.getByRole("button", "I'll reinstall myself").tap();
  await expect(
    screen.getByText("Select Reinstall again, then choose Install."),
  ).toBeVisible();
  await expect(screen.getByRole("link", "Reinstall")).toHaveAttribute(
    "href",
    `https://web.stremio.com/#/addons?addon=${encodeURIComponent(ADDON_URL)}`,
  );
  await screen.getByRole("checkbox", "Always reinstall myself").tap();
  await screen.getByRole("button", "I did it").tap();
  await expect(screen.getByText(CHOICE)).toHaveCount(0);

  // The next catalog change opens on the manual steps at once.
  await changeCatalogs(screen);
  await saveButton(screen).tap();
  await expect(screen.getByRole("button", "I did it")).toBeVisible();
  await expect(
    screen.getByRole("button", "Update it for me instead"),
  ).toBeVisible();
  await expect(screen.getByRole("button", "I'll reinstall myself")).toHaveCount(
    0,
  );
  expect(
    await browser.evaluate((key) => localStorage.getItem(key), MANUAL_KEY),
  ).toBe("1");
  expect(stremio.calls).toEqual([]);
});

test("a sort change asks for no Stremio update", async ({
  app,
  screen,
  browser,
}) => {
  await holdToasts(browser);
  await preparePage(browser, { linked: true });
  await captureConfig(browser);
  const stremio = await routeStremio(
    browser,
    [cinemeta, { ...installed, manifest: servedManifest }],
    servedManifest,
  );
  await openConfigure(app, screen);
  await expect(
    screen.getByText("Stremio updates automatically", { exact: false }),
  ).toBeVisible();

  await screen.getByRole("combobox", "Sort order").tap();
  await screen.getByRole("option", "IMDb Rating (Highest First)").tap();
  await expect(
    screen.getByText("Stremio will update when you save."),
  ).toHaveCount(0);
  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED)).toBeVisible();
  await expect(screen.getByText(CHOICE)).toHaveCount(0);
  expect(stremio.calls).not.toContain("addonCollectionSet");
});

test("with Stremio linked, a catalog save updates Stremio by itself", async ({
  app,
  screen,
  browser,
}) => {
  await holdToasts(browser);
  await preparePage(browser, { linked: true });
  await captureConfig(browser);
  const stremio = await routeStremio(browser);
  await openConfigure(app, screen);

  await changeCatalogs(screen);
  await expect(
    screen.getByText("Stremio will update when you save."),
  ).toBeVisible();
  await expect(screen.getByText(NEEDS_REINSTALL)).toHaveCount(0);
  // The check on load found Stremio up to date and wrote nothing.
  expect(stremio.calls).not.toContain("addonCollectionSet");
  stremio.served = servedManifest;
  await saveButton(screen).tap();
  await expect(screen.getByText(UPDATING_SAVE)).toBeVisible();
  await expect(screen.getByText(UPDATED)).toBeVisible();
  await expect(screen.getByText(CHOICE)).toHaveCount(0);
  expect(stremlistEntry(stremio.collection)?.manifest).toEqual(servedManifest);
  expect(stremio.collection.map((addon) => addon.manifest.id)).toEqual([
    "com.linvo.cinemeta",
    `com.stremlist.${accountId}`,
    "com.stremio.torrentio.addon",
  ]);
  expect(stremio.calls).not.toContain("link");
});

test("an edit made during the save still lets Stremio get what was saved", async ({
  app,
  screen,
  browser,
}) => {
  await preparePage(browser, { linked: true });
  const { submissions, release } = await gatedSaves(browser, configuration);
  const stremio = await routeStremio(browser);
  await openConfigure(app, screen);
  await expect(
    screen.getByText("Stremio updates automatically", { exact: false }),
  ).toBeVisible();

  await changeCatalogs(screen);
  stremio.served = servedManifest;
  await saveButton(screen).tap();
  await expect(saveButton(screen, "Saving")).toBeVisible();
  // A sort change while the save runs leaves unsaved edits behind.
  await screen.getByRole("combobox", "Sort order").tap();
  await screen.getByRole("option", "IMDb Rating (Highest First)").tap();
  release();

  await expect(screen.getByText(UPDATED)).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(stremlistEntry(stremio.collection)?.manifest).toEqual(servedManifest);
});

test("an expired Stremio code can be replaced by a new one", async ({
  app,
  screen,
  browser,
}) => {
  await preparePage(browser);
  await captureConfig(browser);
  const stremio = await routeStremio(browser);
  await openConfigure(app, screen);
  await changeCatalogs(screen);
  stremio.served = servedManifest;
  await saveButton(screen).tap();

  await screen.getByRole("button", "Update it for me").tap();
  await expect(screen.getByText(WAITING)).toBeVisible();
  // Five minutes pass without a confirmation.
  await setClock(browser, 6 * 60_000);
  await expect(screen.getByText("The Stremio code expired")).toBeVisible({
    timeout: 10_000,
  });
  expect(await storedConnection(browser)).toBeNull();
  expect(stremio.calls).not.toContain("addonCollectionSet");

  await setClock(browser, 0);
  await screen.getByRole("button", "Get a new code").tap();
  await expect(screen.getByText(WAITING)).toBeVisible();
  stremio.approved = true;
  await expect(screen.getByText(UPDATED)).toBeVisible({ timeout: 15_000 });
  expect(stremlistEntry(stremio.collection)?.manifest).toEqual(servedManifest);
});

test("when Stremio does not answer, the save stays and the update can be retried", async ({
  app,
  screen,
  browser,
}) => {
  await preparePage(browser, { linked: true });
  const submissions = await captureConfig(browser);
  const stremio = await routeStremio(browser);
  await openConfigure(app, screen);
  await expect(
    screen.getByText("Stremio updates automatically", { exact: false }),
  ).toBeVisible();
  stremio.failure = "down";

  await changeCatalogs(screen);
  stremio.served = servedManifest;
  await saveButton(screen).tap();
  await expect(
    screen.getByText("Saved, but Stremio did not get the update"),
  ).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(stremlistEntry(stremio.collection)?.manifest).toEqual(
    installedManifest,
  );
  // An outage keeps the link.
  expect(await storedConnection(browser)).not.toBeNull();

  stremio.failure = null;
  await screen.getByRole("button", "Try again").tap();
  await expect(screen.getByText(UPDATED)).toBeVisible();
  expect(stremlistEntry(stremio.collection)?.manifest).toEqual(servedManifest);
});

test("a signed-out Stremio session asks to connect again", async ({
  app,
  screen,
  browser,
}) => {
  await preparePage(browser, { linked: true });
  await captureConfig(browser);
  const stremio = await routeStremio(browser);
  await openConfigure(app, screen);
  await expect(
    screen.getByText("Stremio updates automatically", { exact: false }),
  ).toBeVisible();
  stremio.failure = "signed-out";

  await changeCatalogs(screen);
  stremio.served = servedManifest;
  await saveButton(screen).tap();
  await expect(screen.getByText("Stremio signed Stremlist out")).toBeVisible();
  // The dead key is forgotten at once.
  await expect.poll(() => storedConnection(browser)).toBeNull();

  stremio.failure = null;
  await screen.getByRole("button", "Connect Stremio again").tap();
  await expect(screen.getByText(WAITING)).toBeVisible();
  stremio.approved = true;
  await expect(screen.getByText(UPDATED)).toBeVisible({ timeout: 15_000 });
  expect(stremlistEntry(stremio.collection)?.manifest).toEqual(servedManifest);
});

test("a Stremlist removed in Stremio comes back only when asked", async ({
  app,
  screen,
  browser,
}) => {
  await preparePage(browser, { linked: true });
  await captureConfig(browser);
  const stremio = await routeStremio(
    browser,
    [cinemeta, torrentio],
    servedManifest,
  );
  await openConfigure(app, screen);

  // The check on load already finds it missing, and adds nothing.
  await expect(
    screen.getByText("Stremlist is not in this Stremio account"),
  ).toBeVisible();
  expect(stremio.collection).toEqual([cinemeta, torrentio]);
  await expect(
    screen.getByRole("button", "Use another Stremio account"),
  ).toBeVisible();

  await screen.getByRole("button", "Install it again").tap();
  await expect(screen.getByText(UPDATED)).toBeVisible();
  expect(stremio.collection.map((addon) => addon.transportUrl)).toEqual([
    cinemeta.transportUrl,
    torrentio.transportUrl,
    ADDON_URL,
  ]);
  expect(stremlistEntry(stremio.collection)?.manifest).toEqual(servedManifest);
});

test("another Stremio account can be linked when this one has no Stremlist", async ({
  app,
  screen,
  browser,
}) => {
  await preparePage(browser, { linked: true });
  await captureConfig(browser);
  const stremio = await routeStremio(browser, [cinemeta], servedManifest);
  await openConfigure(app, screen);
  await expect(
    screen.getByText("Stremlist is not in this Stremio account"),
  ).toBeVisible();

  await screen.getByRole("button", "Use another Stremio account").tap();
  // A code links the account signed in on stremio.com: change it first.
  await expect(
    screen.getByText("Connect another Stremio account"),
  ).toBeVisible();
  await expect(screen.getByRole("link", "Open stremio.com")).toHaveAttribute(
    "href",
    "https://www.stremio.com/acc-settings",
  );
  expect(await storedConnection(browser)).toBeNull();
  expect(stremio.calls).not.toContain("logout");
  await screen.getByRole("button", "Get a code").tap();
  await expect(screen.getByText(WAITING)).toBeVisible();
  // The other account has this Stremlist installed.
  stremio.collection = [cinemeta, installed];
  stremio.approved = true;
  await expect(screen.getByText(UPDATED)).toBeVisible({ timeout: 15_000 });
  expect(stremlistEntry(stremio.collection)?.manifest).toEqual(servedManifest);
});

test("disconnecting forgets the key and brings back the manual choice", async ({
  app,
  screen,
  browser,
}) => {
  await preparePage(browser, { linked: true });
  await captureConfig(browser);
  const stremio = await routeStremio(
    browser,
    [cinemeta, { ...installed, manifest: servedManifest }],
    servedManifest,
  );
  await openConfigure(app, screen);
  await screen.getByRole("button", "Disconnect").tap();
  await expect(
    screen.getByText("Stremio updates automatically", { exact: false }),
  ).toHaveCount(0);
  expect(await storedConnection(browser)).toBeNull();
  // A Stremio logout would also sign the member out of stremio.com.
  expect(stremio.calls).not.toContain("logout");

  await changeCatalogs(screen);
  await expect(screen.getByText(NEEDS_REINSTALL)).toBeVisible();
  await saveButton(screen).tap();
  await expect(screen.getByText(CHOICE)).toBeVisible();
  expect(stremio.calls).not.toContain("addonCollectionSet");
});
