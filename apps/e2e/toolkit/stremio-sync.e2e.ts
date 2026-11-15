import { test } from "@e2e-dev/web";
import type { Browser, WebRoute } from "@e2e-dev/web";
import { expect } from "e2e";
import type { Screen } from "e2e";
import type { AccountConfigResponse } from "@stremlist/shared/stremio.types";
import {
  SAVED,
  SAVED_REINSTALL,
  SAVED_WITH_CHANGES,
  accountId,
  backend,
  baseRoutes,
  configuration,
  dragSecondAboveFirst,
  holdToasts,
  imdbUser,
  legacyConfiguration,
  routeConfig,
  saveButton,
} from "./config-fixture";
import { isRecord } from "../helpers/json";

// Updating the installed Stremlist through a linked Stremio account, and the
// manual reinstall that stays available. The backend keeps the Stremio key
// and talks to Stremio (ADR 0002): its Stremio routes are answered here by a
// Stremio account in memory. The backend tests cover the encryption and the
// real collection edits against the same answers.

const ADDON_URL = `${backend}/${accountId}/manifest.json`;
const LINK = "https://link.stremio.com/E2E1";
const TOKEN = `E2E1.4102444800000.${"s".repeat(43)}`;
const EMAIL = "member@example.com";
const MANUAL_KEY = "stremlist:stremio-manual";

const TOGGLE = "Show newly detected titles";
const NEEDS_REINSTALL = "These changes need a reinstall.";
const CHOICE = "Update Stremio with your changes";
const UPDATED = "Stremio updated";
const RELOAD_HINT =
  "Reload Stremio Web or restart the app to see your changes.";
const SAVED_BY_HAND =
  "Saved! Reinstall Stremlist in Stremio to see your changes.";
const WAITING = "Confirm in the Stremio tab";
const LINKED = "Updates Stremio on save";

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
/** The manifest of the save: one more catalog. */
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

interface StremioStart {
  /** The member's Stremio addons. */
  collection?: Addon[];
  /** The manifest that the backend builds from the last save. */
  served?: Addon["manifest"];
  linked?: boolean;
  /** The configuration that the page loads. */
  config?: AccountConfigResponse;
  /** Holds every save until it resolves. */
  gate?: Promise<void>;
}

/**
 * The backend's Stremio routes over a Stremio account in memory, and the
 * configuration, whose linked account follows the link. The test approves
 * the code, switches the manifest when it saves and breaks Stremio at will.
 * Every Stremio request is recorded: `create`, `read`, `update`, `install`,
 * `disconnect`, and `addonCollectionSet` for each write.
 */
async function routeStremio(browser: Browser, start: StremioStart = {}) {
  await baseRoutes(browser);
  const { state, submissions } = await routeConfig(
    browser,
    {
      ...(start.config ?? configuration),
      stremio: start.linked ? { email: EMAIL } : null,
    },
    accountId,
    { gate: start.gate },
  );
  const stremio = {
    collection: structuredClone(
      start.collection ?? [cinemeta, installed, torrentio],
    ),
    served: start.served ?? installedManifest,
    approved: false,
    failure: null as Failure,
    /** Stremio gives no code. */
    noCode: false,
    /** While set, each update waits for it. */
    updateGate: null as Promise<void> | null,
    calls: [] as string[],
    submissions,
    get linked() {
      return state.config.stremio !== null;
    },
  };
  const setLinked = (linked: boolean) => {
    state.config = {
      ...state.config,
      stremio: linked ? { email: EMAIL } : null,
    };
  };
  const index = () =>
    stremio.collection.findIndex((addon) => addon.transportUrl === ADDON_URL);

  await browser.route(`${backend}/${accountId}/stremio`, async (route) => {
    stremio.calls.push("disconnect");
    setLinked(false);
    await route.fulfill({ json: { ok: true } });
  });
  await browser.route(`${backend}/${accountId}/stremio/**`, async (route) => {
    const path = new URL(route.request.url).pathname.split("/stremio/")[1];
    if (path === "link") {
      stremio.calls.push("create");
      if (stremio.noCode) {
        return route.fulfill({ status: 502, json: { reason: "unavailable" } });
      }
      return route.fulfill({ json: { link: LINK, token: TOKEN } });
    }
    if (path === "link/confirm") {
      const body: unknown = JSON.parse(route.request.postData ?? "{}");
      const token = isRecord(body) ? body.token : undefined;
      if (token !== TOKEN) {
        throw new Error(`Unexpected link token ${JSON.stringify(token)}`);
      }
      stremio.calls.push("read");
      if (stremio.approved) setLinked(true);
      return route.fulfill({
        json: { stremio: stremio.approved ? { email: EMAIL } : null },
      });
    }
    stremio.calls.push(path);
    if (stremio.failure === "down") {
      return route.fulfill({ status: 502, json: { reason: "unavailable" } });
    }
    if (stremio.failure === "signed-out" || !stremio.linked) {
      setLinked(false);
      return route.fulfill({ status: 409, json: { reason: "signed-out" } });
    }
    await answer(route, path);
  });

  async function answer(route: WebRoute, path: string) {
    const at = index();
    const write = (collection: Addon[]) => {
      stremio.calls.push("addonCollectionSet");
      stremio.collection = collection;
    };
    if (path === "install") {
      if (at < 0) {
        write([
          ...stremio.collection,
          { transportUrl: ADDON_URL, manifest: stremio.served, flags: {} },
        ]);
      }
      return route.fulfill({ json: { result: "updated" } });
    }
    if (path !== "update") throw new Error(`Unexpected Stremio route ${path}`);
    if (stremio.updateGate) await stremio.updateGate;
    if (at < 0) return route.fulfill({ json: { result: "missing" } });
    const current = stremio.collection[at].manifest;
    if (JSON.stringify(current) === JSON.stringify(stremio.served)) {
      return route.fulfill({ json: { result: "unchanged" } });
    }
    write(
      stremio.collection.map((addon, position) =>
        position === at ? { ...addon, manifest: stremio.served } : addon,
      ),
    );
    await route.fulfill({ json: { result: "updated" } });
  }

  return stremio;
}

declare global {
  interface Window {
    // Set by the init script of preparePage before the app runs.
    /** The tabs that `window.open` gave the app. */
    e2eTabs: { location: { href: string }; opener: unknown }[];
    /** How far the page clock runs ahead of real time (setClock). */
    e2eClockOffset: number;
    e2eUpdates: { running: number; most: number };
  }
}

/**
 * Keeps toasts on screen, records the Stremio tab instead of opening it,
 * lets the test move the clock forward, and starts with the manual choice
 * remembered when asked.
 */
async function preparePage(
  browser: Browser,
  start: { manual?: boolean; blockTabs?: boolean } = {},
) {
  await holdToasts(browser);
  await browser.addInitScript(
    ({ manual, manualKey, blockTabs }) => {
      const page = window;
      page.e2eTabs = [];
      page.e2eClockOffset = 0;
      // How many Stremio updates this page has waiting at the same time.
      page.e2eUpdates = { running: 0, most: 0 };
      const send = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url =
          input instanceof Request
            ? input.url
            : new URL(input, location.href).href;
        if (!url.endsWith("/stremio/update")) return send(input, init);
        const updates = page.e2eUpdates;
        updates.running++;
        updates.most = Math.max(updates.most, updates.running);
        try {
          return await send(input, init);
        } finally {
          updates.running--;
        }
      };
      const now = Date.now.bind(Date);
      Date.now = () => now() + page.e2eClockOffset;
      // The fake tab is no Window, so it replaces `open` without its type.
      Object.defineProperty(window, "open", {
        value: () => {
          // An in-app browser can refuse new tabs.
          if (blockTabs) return null;
          const tab = { location: { href: "" }, opener: window, close() {} };
          page.e2eTabs.push(tab);
          return tab;
        },
      });
      if (manual) localStorage.setItem(manualKey, "1");
    },
    {
      manual: !!start.manual,
      manualKey: MANUAL_KEY,
      blockTabs: !!start.blockTabs,
    },
  );
}

/** Everything this browser stored: never a Stremio key. */
function browserStorage(browser: Browser) {
  return browser.evaluate(() => {
    const stored = new Map<string, string | null>();
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (key !== null) stored.set(key, storage.getItem(key));
      }
    }
    return JSON.stringify(Object.fromEntries(stored));
  });
}

/** Moves the page clock `ms` ahead of real time (0 to undo). */
function setClock(browser: Browser, ms: number) {
  return browser.evaluate((offset) => {
    window.e2eClockOffset = offset;
    return offset;
  }, ms);
}

/** The address the Stremio tab was sent to, or null. */
function stremioTab(browser: Browser) {
  return browser.evaluate(() => {
    return window.e2eTabs.at(-1)?.location.href ?? null;
  });
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
  await preparePage(browser);
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
  // The card shows the result. The save toast pointed at the choice; a toast
  // that says how to see the update takes its place.
  await expect(screen.getByText(UPDATED)).toBeVisible({ timeout: 15_000 });
  await expect(screen.getByText(`${UPDATED}. ${RELOAD_HINT}`)).toBeVisible();
  await expect(screen.getByText(SAVED_REINSTALL)).toHaveCount(0);
  await expect(screen.getByText(CHOICE)).toHaveCount(0);
  // The account menu stays next to the result, and keeps the hint.
  await screen.getByRole("button", UPDATED).tap();
  await expect(screen.getByRole("menuitem", "Disconnect")).toBeVisible();
  await expect(screen.getByText(RELOAD_HINT)).toBeVisible();
  await browser.keyboard.press("Escape");
  // Only the Stremlist entry changed, in place, with the saved catalogs.
  expect(stremio.collection).toEqual([
    cinemeta,
    { ...installed, manifest: servedManifest },
    torrentio,
  ]);
  // The link lives on the server, not in this browser.
  expect(stremio.linked).toBe(true);
  expect(await browserStorage(browser)).not.toContain("stremio-connection");

  // The link survives a reload; Stremio already has the setup, so the check
  // on load writes nothing and says nothing.
  const writes = stremio.calls.filter((c) => c === "addonCollectionSet");
  await browser.reload();
  await screen.getByRole("button", LINKED).tap();
  await expect(screen.getByText("me•••@example.com")).toBeVisible();
  await browser.keyboard.press("Escape");
  await expect
    .poll(() => stremio.calls.filter((c) => c === "update").length)
    .toBe(2);
  expect(stremio.calls.filter((c) => c === "addonCollectionSet")).toEqual(
    writes,
  );
  await expect(screen.getByText(UPDATED)).toHaveCount(0);
});

test("a Stremio app that wrote an older copy back is repaired when the page opens", async ({
  app,
  screen,
  browser,
}) => {
  await preparePage(browser);
  const stremio = await routeStremio(browser, {
    linked: true,
    served: servedManifest,
  });
  await openConfigure(app, screen);

  await expect(screen.getByText(UPDATED)).toBeVisible();
  expect(stremlistEntry(stremio.collection)?.manifest).toEqual(servedManifest);
  expect(stremio.calls).toEqual(["update", "addonCollectionSet"]);
});

test("reinstalling by hand stays available and can become the default", async ({
  app,
  screen,
  browser,
}) => {
  await preparePage(browser);
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

  // The next catalog change opens on the manual steps at once, and the
  // save toast links to the reinstall.
  await changeCatalogs(screen);
  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED_BY_HAND)).toBeVisible();
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

  // Back to the choice: the next save toast has no Reinstall action, even
  // while the previous toast, which had one, is still on screen.
  await screen.getByRole("checkbox", "Always reinstall myself").tap();
  await screen.getByRole("button", "Settings for Test catalog").tap();
  await screen.getByLabel("Catalog title").fill("Renamed catalog");
  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED_REINSTALL)).toBeVisible();
  await expect(
    screen.getByRole("button", "Reinstall", { exact: true }),
  ).toHaveCount(0);
  expect(stremio.calls).toEqual([]);
});

test("a Legacy alias install can only reinstall by hand", async ({
  app,
  screen,
  browser,
}) => {
  await preparePage(browser);
  const stremio = await routeStremio(browser, {
    config: legacyConfiguration,
  });
  await routeConfig(browser, legacyConfiguration, imdbUser);
  await app.open(`/configure?account=${imdbUser}`);
  await expect(screen.getByRole("checkbox", TOGGLE)).toBeVisible();

  await changeCatalogs(screen);
  await expect(
    screen.getByText("After you save, reinstall Stremlist.", { exact: false }),
  ).toBeVisible();
  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED_BY_HAND)).toBeVisible();
  await expect(
    screen.getByText("Select Reinstall again, then choose Install."),
  ).toBeVisible();
  await expect(screen.getByRole("button", "Update it for me")).toHaveCount(0);
  await expect(
    screen.getByRole("button", "Update it for me instead"),
  ).toHaveCount(0);
  expect(stremio.calls).toEqual([]);
});

test("a sort change asks for no Stremio update", async ({
  app,
  screen,
  browser,
}) => {
  await preparePage(browser);
  const stremio = await routeStremio(browser, {
    linked: true,
    collection: [cinemeta, { ...installed, manifest: servedManifest }],
    served: servedManifest,
  });
  await openConfigure(app, screen);
  await expect(screen.getByText(LINKED)).toBeVisible();

  await screen.getByRole("combobox", "Sort order").tap();
  await screen.getByRole("option", "IMDb Rating (Highest First)").tap();
  await expect(
    screen.getByText("Stremio will update when you save."),
  ).toHaveCount(0);
  await saveButton(screen).tap();
  await expect(screen.getByText(SAVED)).toBeVisible();
  await expect(screen.getByText(CHOICE)).toHaveCount(0);
  expect(stremio.calls).toEqual(["update"]);
});

test("with Stremio linked, a catalog save updates Stremio by itself", async ({
  app,
  screen,
  browser,
}) => {
  await preparePage(browser);
  const stremio = await routeStremio(browser, { linked: true });
  await openConfigure(app, screen);

  await changeCatalogs(screen);
  await expect(
    screen.getByText("Stremio will update when you save."),
  ).toBeVisible();
  await expect(screen.getByText(NEEDS_REINSTALL)).toHaveCount(0);
  // The check on load found Stremio up to date and wrote nothing.
  expect(stremio.calls).toEqual(["update"]);
  stremio.served = servedManifest;
  await saveButton(screen).tap();
  // The save toast becomes the result, with how to see it.
  await expect(screen.getByText(`${UPDATED}. ${RELOAD_HINT}`)).toBeVisible();
  await expect(screen.getByText(UPDATED)).toBeVisible();
  await expect(screen.getByText(CHOICE)).toHaveCount(0);
  expect(stremlistEntry(stremio.collection)?.manifest).toEqual(servedManifest);
  expect(stremio.collection.map((addon) => addon.manifest.id)).toEqual([
    "com.linvo.cinemeta",
    `com.stremlist.${accountId}`,
    "com.stremio.torrentio.addon",
  ]);
  expect(stremio.calls).not.toContain("create");
});

const second = {
  ...configuration.lists[0],
  id: "00000000-0000-4000-8000-000000000002",
  sourceRef: "ls99123456",
  catalogTitle: "Second catalog",
  position: 1,
};

// Every edit that changes what Stremio reads at install time.
const CATALOG_EDITS: {
  name: string;
  edit: (screen: Screen, browser: Browser) => Promise<void>;
}[] = [
  {
    name: "renaming a List",
    edit: async (screen) => {
      await screen.getByRole("button", "Settings for Test catalog").tap();
      // Each List has a Settings panel: Test catalog is the first.
      await screen.getByLabel("Catalog title").first().fill("Renamed catalog");
    },
  },
  {
    name: "moving a List",
    edit: (_, browser) => dragSecondAboveFirst(browser),
  },
  {
    name: "adding a List",
    edit: async (screen) => {
      await screen.getByRole("button", "Add an IMDb chart").tap();
      await screen.getByRole("menuitem", /^Top 250 Movies/).tap();
    },
  },
  {
    name: "removing a List",
    edit: async (screen) => {
      await screen.getByRole("button", "Remove Second catalog").tap();
    },
  },
  {
    name: "showing movies only",
    edit: async (screen) => {
      await screen.getByRole("button", "Settings for Test catalog").tap();
      await screen.getByRole("combobox", "Show", { exact: true }).first().tap();
      await screen.getByRole("option", "Movies only").tap();
    },
  },
];

for (const { name, edit } of CATALOG_EDITS) {
  test(`with Stremio linked, ${name} updates Stremio on save`, async ({
    app,
    screen,
    browser,
  }) => {
    await browser.setViewport({ width: 1280, height: 1800 });
    await preparePage(browser);
    const stremio = await routeStremio(browser, {
      linked: true,
      config: { ...configuration, lists: [configuration.lists[0], second] },
    });
    await openConfigure(app, screen);
    await expect(screen.getByText(LINKED)).toBeVisible();

    await edit(screen, browser);
    await expect(
      screen.getByText("Stremio will update when you save."),
    ).toBeVisible();
    stremio.served = servedManifest;
    await saveButton(screen).tap();
    await expect(screen.getByText(UPDATED)).toBeVisible();
    expect(stremlistEntry(stremio.collection)?.manifest).toEqual(
      servedManifest,
    );
    expect(
      stremio.calls.filter((c) => c === "addonCollectionSet"),
    ).toHaveLength(1);
  });
}

test("an edit made during the save still lets Stremio get what was saved", async ({
  app,
  screen,
  browser,
}) => {
  await preparePage(browser);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stremio = await routeStremio(browser, { linked: true, gate });
  await openConfigure(app, screen);
  await expect(screen.getByText(LINKED)).toBeVisible();

  await changeCatalogs(screen);
  stremio.served = servedManifest;
  await saveButton(screen).tap();
  await expect(saveButton(screen, "Saving")).toBeVisible();
  // A sort change while the save runs leaves unsaved edits behind.
  await screen.getByRole("combobox", "Sort order").tap();
  await screen.getByRole("option", "IMDb Rating (Highest First)").tap();
  release();

  await expect(screen.getByText(SAVED_WITH_CHANGES)).toBeVisible();
  await expect
    .poll(() => stremlistEntry(stremio.collection)?.manifest)
    .toEqual(servedManifest);
  expect(stremio.submissions).toHaveLength(1);
  await expect(screen.getByText(UPDATED)).toBeVisible();
  // The toast still says that edits are left to save.
  await expect(screen.getByText(SAVED_WITH_CHANGES)).toBeVisible();
});

test("a save made while Stremio updates becomes one more update", async ({
  app,
  screen,
  browser,
}) => {
  await preparePage(browser);
  const stremio = await routeStremio(browser, { linked: true });
  await openConfigure(app, screen);
  await expect(screen.getByText(LINKED)).toBeVisible();
  expect(stremio.calls).toEqual(["update"]);

  let release = () => {};
  stremio.updateGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await changeCatalogs(screen);
  stremio.served = servedManifest;
  await saveButton(screen).tap();
  await expect.poll(() => stremio.calls.length).toBe(2);

  // A second save while the first update waits for Stremio: no second
  // request at the same time.
  await screen.getByRole("button", "Settings for Test catalog").tap();
  await screen.getByLabel("Catalog title").fill("Renamed catalog");
  const renamed = {
    ...servedManifest,
    catalogs: servedManifest.catalogs.map((catalog) =>
      catalog.id === "watchlist"
        ? { ...catalog, name: "Renamed catalog" }
        : catalog,
    ),
  };
  stremio.served = renamed;
  await saveButton(screen).tap();
  await expect.poll(() => stremio.submissions.length).toBe(2);
  // The save ended (nothing left to save) while the first update waits.
  await expect(saveButton(screen)).toBeDisabled();

  stremio.updateGate = null;
  release();
  await expect(screen.getByText(UPDATED)).toBeVisible();
  // One more update after the first, with the last save.
  await expect
    .poll(() => stremio.calls.filter((call) => call === "update").length)
    .toBe(3);
  expect(stremlistEntry(stremio.collection)?.manifest).toEqual(renamed);
  expect(await browser.evaluate(() => window.e2eUpdates.most)).toBe(1);
});

test("when Stremio gives no code, the card says so and a new try works", async ({
  app,
  screen,
  browser,
}) => {
  await preparePage(browser);
  const stremio = await routeStremio(browser);
  await openConfigure(app, screen);
  await changeCatalogs(screen);
  stremio.served = servedManifest;
  await saveButton(screen).tap();

  stremio.noCode = true;
  await screen.getByRole("button", "Update it for me").tap();
  await expect(screen.getByText("Stremio did not give a code")).toBeVisible();
  await expect(
    screen.getByText("Saved, but Stremio did not get the update"),
  ).toHaveCount(0);

  stremio.noCode = false;
  await screen.getByRole("button", "Try again").tap();
  await expect(screen.getByText(WAITING)).toBeVisible();
  stremio.approved = true;
  await expect(screen.getByText(UPDATED)).toBeVisible({ timeout: 15_000 });
});

test("a browser that blocks the Stremio tab still offers the Stremio page", async ({
  app,
  screen,
  browser,
}) => {
  await preparePage(browser, { blockTabs: true });
  const stremio = await routeStremio(browser);
  await openConfigure(app, screen);
  await changeCatalogs(screen);
  stremio.served = servedManifest;
  await saveButton(screen).tap();

  await screen.getByRole("button", "Update it for me").tap();
  await expect(screen.getByText("Confirm in Stremio")).toBeVisible();
  await expect(screen.getByRole("link", "Open Stremio")).toHaveAttribute(
    "href",
    LINK,
  );
  stremio.approved = true;
  await expect(screen.getByText(UPDATED)).toBeVisible({ timeout: 15_000 });
});

test("an expired Stremio code can be replaced by a new one", async ({
  app,
  screen,
  browser,
}) => {
  await preparePage(browser);
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
  expect(stremio.linked).toBe(false);
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
  await preparePage(browser);
  const stremio = await routeStremio(browser, { linked: true });
  await openConfigure(app, screen);
  await expect(screen.getByText(LINKED)).toBeVisible();
  stremio.failure = "down";

  await changeCatalogs(screen);
  stremio.served = servedManifest;
  await saveButton(screen).tap();
  await expect(
    screen.getByText("Saved, but Stremio did not get the update"),
  ).toBeVisible();
  expect(stremio.submissions).toHaveLength(1);
  expect(stremlistEntry(stremio.collection)?.manifest).toEqual(
    installedManifest,
  );
  // An outage keeps the link.
  expect(stremio.linked).toBe(true);

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
  await preparePage(browser);
  const stremio = await routeStremio(browser, { linked: true });
  await openConfigure(app, screen);
  await expect(screen.getByText(LINKED)).toBeVisible();
  stremio.failure = "signed-out";

  await changeCatalogs(screen);
  stremio.served = servedManifest;
  await saveButton(screen).tap();
  await expect(screen.getByText("Stremio signed Stremlist out")).toBeVisible();
  // The backend forgot the dead key.
  expect(stremio.linked).toBe(false);
  await expect(screen.getByText(LINKED)).toHaveCount(0);

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
  await preparePage(browser);
  const stremio = await routeStremio(browser, {
    linked: true,
    collection: [cinemeta, torrentio],
    served: servedManifest,
  });
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
  await preparePage(browser);
  const stremio = await routeStremio(browser, {
    linked: true,
    collection: [cinemeta],
    served: servedManifest,
  });
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
  expect(stremio.linked).toBe(false);
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
  await preparePage(browser);
  const stremio = await routeStremio(browser, {
    linked: true,
    collection: [cinemeta, { ...installed, manifest: servedManifest }],
    served: servedManifest,
  });
  await openConfigure(app, screen);
  await screen.getByRole("button", LINKED).tap();
  await screen.getByRole("menuitem", "Disconnect").tap();
  await expect(screen.getByText(LINKED)).toHaveCount(0);
  expect(stremio.calls).toContain("disconnect");
  expect(stremio.linked).toBe(false);

  await changeCatalogs(screen);
  await expect(screen.getByText(NEEDS_REINSTALL)).toBeVisible();
  await saveButton(screen).tap();
  await expect(screen.getByText(CHOICE)).toBeVisible();
  expect(stremio.calls).not.toContain("addonCollectionSet");
});
