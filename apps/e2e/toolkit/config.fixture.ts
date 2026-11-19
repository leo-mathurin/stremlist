import type { Browser, WebRoute } from "@e2e-dev/web";
import type {
  CatalogPreview,
  CatalogPreviewResponse,
  CatalogPreviewRow,
} from "@stremlist/shared/catalog-preview";
import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import { LEGACY_ALIAS_PATTERN } from "@stremlist/shared/constants";
import type { DisplayMode } from "@stremlist/shared/constants";
import { expect } from "e2e";
import type { Screen } from "e2e";
import type { ProviderId } from "@stremlist/shared/providers";
import { PROVIDER_IDS } from "@stremlist/shared/providers";
import type {
  AccountConfigInput,
  AccountConfigResponse,
  ConfigList,
  ConnectionSummary,
} from "@stremlist/shared/stremio.types";
import type { ListSyncStatus } from "@stremlist/shared/sync-status";
import { type Guard, isRecord, isString, parseJson } from "../helpers/json";

export const backend = "http://127.0.0.1:4314";
/** A private Account ID (`sl_` and 22 base62 characters). */
export const accountId = "sl_E2eFixtureAccount00001";
export const secondAccountId = "sl_E2eFixtureAccount00002";
/** The IMDb watchlist of the fixture List; also a Legacy alias. */
export const imdbUser = "ur99123456";

export const SAVED = "Saved! Your catalogs will refresh with the new settings.";
export const SAVED_REINSTALL = "Saved! Choose how Stremio gets your changes.";
export const SAVED_WITH_CHANGES =
  "Saved the submitted settings. You have unsaved changes: save again to apply them.";

/** The label of the Save button before the first save creates the Account. */
export const SAVE_NEW = "Save";

/** Open the Quick add row of `provider`, unless it is already open. */
export async function openQuickAdd(screen: Screen, provider: ProviderId) {
  const row = screen.getByTestId(`quick-add-${provider}`);
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.tap();
}

/** Add the built-in IMDb chart `name` from Quick add. */
export async function addImdbChart(screen: Screen, name: string | RegExp) {
  await openQuickAdd(screen, "imdb");
  await screen.getByRole("button", name).tap();
}

/**
 * The Save button at the top of the Lists column. The floating Save button
 * at the bottom has the same name and stays in the page while it is hidden,
 * so take the first one.
 */
export function saveButton(screen: Screen, name = "Save") {
  return screen.getByRole("button", name, { exact: true }).first();
}

declare global {
  interface Window {
    /** The Sonner close timers that `holdToasts` held on this page. */
    e2eHeldToasts: number;
  }
}

const TOAST_NOT_HELD = "/__e2e/toast-not-held";

/**
 * Keeps toasts on screen until they are replaced or closed. Save and
 * newsletter results are toasts that close after 6 to 10 seconds, and an AI
 * goal can take longer than that to finish, so a check of the toast after the
 * goal could find it gone. A fake timer stops only the timer that closes a
 * toast (the Sonner timer that calls `onAutoClose`): it never fires, and
 * `clearTimeout` still cancels it. Every other timer of the app runs on the
 * real clock. The page counts the held timers in `window.e2eHeldToasts`.
 *
 * Each toast must get its own held timer. Sonner adds a toast and changes its
 * type (for example from loading to a result) in a `flushSync` render, and
 * starts the close timer in the effects of that render, before the page
 * observes the change. So a toast takes a held timer that was started in the
 * same task in which the toast was added or changed its type. A toast that
 * reaches `data-mounted` with no held timer of its own, or that changes to a
 * result with no new held timer, while its timer runs, means that Sonner
 * changed its close timer: the page tells the test, which fails at its next
 * step.
 *
 * The timer of a toast runs while the page is visible, the toast is not
 * loading or removed, and the toaster is not expanded (`data-expanded`, set
 * while the pointer is over it) or pressed (between a `pointerdown` and a
 * `pointerup` in it). Sonner starts the timer again when the toaster
 * collapses, when the press ends, or when the page becomes visible. A
 * collapse renders at a lower priority, so its effects can run in a later
 * task than the change of `data-expanded`. So each toast whose timer starts
 * again takes a held timer of the same task, or else the next held timer;
 * when the page is next idle, a toast whose timer runs and that got no held
 * timer also fails the test.
 */
export async function holdToasts(browser: Browser) {
  await browser.route(`**${TOAST_NOT_HELD}`, () => {
    throw new Error(
      "holdToasts held no close timer for a toast: Sonner's close timer no longer calls onAutoClose, or no longer starts when the toast is added or its timer starts again. Update holdToasts.",
    );
  });
  await browser.addInitScript((notHeld: string) => {
    const realSetTimeout = window.setTimeout.bind(window);
    const send = window.fetch.bind(window);
    const toastSelector = "[data-sonner-toast]";
    let unclaimed: number[] = [];
    let owed: Element[] = [];
    let pressed = false;
    const heldOnAdd = new WeakMap<Element, boolean>();
    window.e2eHeldToasts = 0;
    Object.defineProperty(window, "setTimeout", {
      configurable: true,
      writable: true,
      value: (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (
          typeof handler === "function" &&
          handler.toString().includes("onAutoClose")
        ) {
          window.e2eHeldToasts += 1;
          const timer = realSetTimeout(() => {}, 2 ** 31 - 1);
          if (owed.shift() !== undefined) return timer;
          if (unclaimed.length === 0) {
            queueMicrotask(() => {
              unclaimed = [];
            });
          }
          unclaimed.push(timer);
          return timer;
        }
        return realSetTimeout(handler, timeout, ...args);
      },
    });
    const timerRuns = (toast: Element) =>
      !document.hidden &&
      !pressed &&
      toast.getAttribute("data-type") !== "loading" &&
      toast.getAttribute("data-removed") !== "true" &&
      toast.getAttribute("data-expanded") !== "true";
    const claimTimer = (toast: Element) =>
      !timerRuns(toast) || unclaimed.shift() !== undefined;
    const reportNotHeld = () => {
      void send(notHeld, { method: "POST" });
    };
    const checkOwed = () => {
      const unpaid = owed.filter(
        (toast) => toast.isConnected && timerRuns(toast),
      );
      owed = [];
      if (unpaid.length > 0) reportNotHeld();
    };
    const timerStartsAgain = (toast: Element) => {
      if (claimTimer(toast)) return;
      if (owed.length === 0) requestIdleCallback(checkOwed);
      owed.push(toast);
    };
    const restartRunningTimers = () => {
      for (const toast of document.querySelectorAll(toastSelector)) {
        timerStartsAgain(toast);
      }
    };
    const inToaster = (event: Event) =>
      event.target instanceof Element &&
      event.target.closest("[data-sonner-toaster]") !== null;
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (
          inToaster(event) &&
          !(
            event.target instanceof HTMLElement &&
            event.target.dataset.dismissible === "false"
          )
        ) {
          pressed = true;
        }
      },
      true,
    );
    document.addEventListener(
      "pointerup",
      (event) => {
        if (!pressed || !inToaster(event)) return;
        pressed = false;
        restartRunningTimers();
      },
      true,
    );
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) restartRunningTimers();
    });
    const addedToasts = (nodes: NodeList) =>
      Array.from(nodes).flatMap((node) =>
        node instanceof Element
          ? [
              ...(node.matches(toastSelector) ? [node] : []),
              ...node.querySelectorAll(toastSelector),
            ]
          : [],
      );
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "childList") {
          for (const toast of addedToasts(record.addedNodes)) {
            heldOnAdd.set(toast, claimTimer(toast));
          }
          continue;
        }
        const toast = record.target;
        if (!(toast instanceof Element) || !toast.matches(toastSelector)) {
          continue;
        }
        if (record.attributeName === "data-type" && !claimTimer(toast)) {
          reportNotHeld();
        }
        if (
          record.attributeName === "data-mounted" &&
          toast.getAttribute("data-mounted") === "true" &&
          heldOnAdd.get(toast) !== true &&
          timerRuns(toast)
        ) {
          reportNotHeld();
        }
        if (
          record.attributeName === "data-expanded" &&
          record.oldValue === "true"
        ) {
          timerStartsAgain(toast);
        }
      }
    }).observe(document, {
      attributeFilter: ["data-expanded", "data-mounted", "data-type"],
      attributeOldValue: true,
      childList: true,
      subtree: true,
    });
  }, TOAST_NOT_HELD);
}

/**
 * Waits until the page is idle. Then `holdToasts` has checked each toast whose
 * close timer started again, and a missed hold fails the next step.
 */
export async function waitForIdlePage(browser: Browser) {
  await browser.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        requestIdleCallback(() => resolve(true));
      }),
  );
}

/**
 * Makes the viewport taller than the configure page, also with the filters,
 * a Select or a Catalog preview open, so the page cannot scroll. The Save
 * button at the top then stays in view and the floating Save button, which
 * has the same name, stays hidden and inert. Without it, the end state of an
 * AI goal depends on the scroll position, which differs between machines: a
 * recording run that scrolled the top button away saw the floating button
 * (an end anchor and a second "Save"), and the replay in CI, which did not
 * scroll, did not find it (REPLAY_STALE, end-mismatch). The tallest page of
 * the toolkit ends about 2200px down on macOS; the extra height covers
 * fonts that wrap more lines on Linux.
 */
export async function fitConfigurePage(browser: Browser) {
  await browser.setViewport({ width: 1280, height: 3200 });
}

/**
 * Opens the Settings of a List, then its "Filters & extra catalogs". The
 * filters button is in the Settings panel, which grows open with a CSS
 * transition. A tap during that transition can be lost: the filters stay
 * closed, and their controls stay in the page, so a check that they are
 * enabled or disabled still passes. Wait for the panel to finish opening, then
 * check that the filters opened.
 */
export async function openFilters(
  screen: Screen,
  browser: Browser,
  title = "Test catalog",
) {
  const settings = screen.getByRole("button", `Settings for ${title}`);
  await settings.tap();
  await expect(settings).toBeExpanded();
  await expect
    .poll(() =>
      browser.evaluate(() =>
        document
          .getAnimations()
          .some(
            (animation) =>
              animation instanceof CSSTransition &&
              animation.playState === "running",
          ),
      ),
    )
    .toBe(false);
  const filters = screen.getByRole("button", /^Filters & extra catalogs/);
  await filters.tap();
  await expect(filters).toBeExpanded();
}

export const row = {
  id: "00000000-0000-4000-8000-000000000001",
  provider: "imdb",
  sourceRef: imdbUser,
  catalogTitle: "Test catalog",
  sortOption: "added_at-asc",
  displayMode: "split",
  position: 0,
  catalogSettings: {},
  availableGenres: ["Drama", "Comedy"],
} satisfies ConfigList;

/**
 * A successful refresh of `sourceRef` (of `provider`) at `at` that gave
 * `titleCount` Titles.
 */
export function syncedStatus(
  sourceRef: string,
  titleCount = 12,
  at = "2020-01-01T00:00:00.000Z",
  provider: ProviderId = "imdb",
) {
  return {
    provider,
    sourceRef,
    lastAttemptAt: at,
    lastSuccessAt: at,
    titleCount,
    problem: null,
    failingSince: null,
  } satisfies ListSyncStatus;
}

/** Pick RPDB posters, so that the RPDB API key field shows. */
export async function chooseRpdb(screen: Screen) {
  await screen.getByRole("combobox", "Posters").tap();
  await screen.getByRole("option", /^RPDB/).tap();
}

/** A Connection that the Provider accepts. */
export function connected(
  provider: ProviderId,
  username: string | null = "someone",
) {
  return {
    provider,
    username,
    connectedAt: "2026-10-01T00:00:00.000Z",
    needsRenewalSince: null,
  } satisfies ConnectionSummary;
}

export const configuration = {
  access: "private",
  accountId,
  rpdbApiKey: null,
  posterSource: "imdb",
  lists: [row],
  syncStatus: { [row.id]: [syncedStatus(row.sourceRef)] },
  connections: [],
  actions: { enabled: false, providers: [] },
  newTitles: {
    enabled: false,
    summary: { detected: 0, latestDetectedAt: null, waitingLists: 0 },
  },
  lastFetchedAt: "2020-01-01T00:00:00.000Z",
  cooldownSeconds: 2,
  stremio: null,
} satisfies AccountConfigResponse;

/** The same Account seen through its Legacy alias (ADR 0001). */
export const legacyConfiguration = {
  ...configuration,
  access: "legacy",
  accountId: null,
} satisfies AccountConfigResponse;

/**
 * `GET /providers`: every Provider on, OAuth configured where it exists, and
 * no outage.
 */
export function providerStatus(
  overrides: Partial<
    Record<
      ProviderId,
      { enabled?: boolean; connectable?: boolean; outageSince?: string }
    >
  > = {},
) {
  return {
    providers: PROVIDER_IDS.map((id) => ({
      id,
      enabled: overrides[id]?.enabled ?? true,
      connectable:
        overrides[id]?.connectable ??
        ["trakt", "simkl", "mdblist"].includes(id),
      outageSince: overrides[id]?.outageSince ?? null,
    })),
  };
}

/** The body of a `POST /lists/preview` request. */
export interface PreviewRequest {
  accountKey?: string;
  provider: ProviderId;
  sourceRef: string;
  /** The other Source lists of a merged List; absent for one Source list. */
  mergedSources?: { provider: ProviderId; sourceRef: string }[];
  sortOption: string;
  displayMode: DisplayMode;
  catalogSettings?: CatalogSettings;
  /** The place in a Provider's queue from a queued answer. */
  ticket?: string;
}

/**
 * A Catalog preview for `request`: two movies, no series and no Unresolved
 * entries, unless `overrides` says otherwise. Posters are null, so no image
 * request leaves the test.
 */
export function previewOf(
  request: Pick<PreviewRequest, "displayMode">,
  overrides: Partial<CatalogPreview> = {},
) {
  const titles = [
    {
      id: "tt0111161",
      type: "movie" as const,
      name: "The Shawshank Redemption",
      poster: null,
      releaseInfo: "1994",
    },
    {
      id: "tt0068646",
      type: "movie" as const,
      name: "The Godfather",
      poster: null,
      releaseInfo: "1972",
    },
  ];
  const types: CatalogPreviewRow["type"][] =
    request.displayMode === "split"
      ? ["movie", "series"]
      : [request.displayMode];
  const preview: CatalogPreview = {
    ok: true,
    titleCount: titles.length,
    typeCounts: { movie: titles.length, series: 0 },
    catalogs: types.map((type) => ({
      type,
      preset: null,
      total: type === "movie" ? titles.length : 0,
      titles: type === "movie" ? titles : [],
    })),
    unresolved: { count: 0, notCheckedYet: 0, entries: [] },
    withoutDetails: 0,
    ...overrides,
  };
  return preview;
}

/**
 * Register first: answers the requests every page makes (`/providers`,
 * `/stats`, the `/sync-status` poll, Watch tracking), and the Catalog preview that an added
 * List opens (with `previewOf`). Fails the test on any other request that a
 * later, more specific route did not take.
 */
export async function baseRoutes(
  browser: Browser,
  providers = providerStatus(),
) {
  await browser.route(`${backend}/**`, async (route) => {
    const { pathname } = new URL(route.request.url);
    if (pathname === "/providers") await route.fulfill({ json: providers });
    else if (pathname === "/stats")
      await route.fulfill({ json: { activeUsers: 2 } });
    else if (pathname.endsWith("/sync-status"))
      await route.fulfill({
        json: toJson({
          syncStatus: configuration.syncStatus,
          connections: [],
        }),
      });
    else if (
      route.request.method === "GET" &&
      pathname.endsWith("/watch-tracking")
    )
      await route.fulfill({
        json: { stremioLinked: false, stremioTrakt: false, destinations: [] },
      });
    else if (
      route.request.method === "GET" &&
      /^\/[^/]+\/config$/.test(pathname) &&
      LEGACY_ALIAS_PATTERN.test(decodeURIComponent(pathname.split("/")[1]))
    )
      await route.fulfill({
        status: 404,
        json: { error: "Addon not found. Install it first." },
      });
    else if (pathname === "/lists/preview" && route.request.method === "POST")
      await route.fulfill({
        json: toJson(previewOf(parseBody(route, isPreviewRequest))),
      });
    else
      throw new Error(
        `Unexpected test API request: ${route.request.method} ${pathname}`,
      );
  });
}

/** What a saved configuration answers: the submitted Lists with IDs. */
export function savedLists(
  submitted: AccountConfigInput,
  genres: string[] = ["Drama", "Comedy"],
) {
  const lists: ConfigList[] = submitted.lists.map((list, index) => ({
    catalogTitle: "",
    displayMode: "split",
    ...list,
    id: list.id ?? `00000000-0000-4000-8000-00000000010${index}`,
    position: index,
    availableGenres: genres,
  }));
  return lists;
}

type Json = NonNullable<Parameters<WebRoute["fulfill"]>[0]["json"]>;

function isJsonValue(value: unknown): value is Json | null {
  if (value === null) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return ["string", "number", "boolean"].includes(typeof value);
}

/** Typed fixtures as a route body (interfaces are not JSON-typed). */
export function toJson<T>(value: T) {
  const json: unknown = JSON.parse(JSON.stringify(value));
  if (json === null || !isJsonValue(json)) {
    throw new Error(`Not a JSON route body: ${JSON.stringify(value)}`);
  }
  return json;
}

/** The JSON body that the app sent, as checked by `is`. */
export function parseBody<T>(route: WebRoute, is: Guard<T>) {
  return parseJson(route.request.postData ?? "{}", is, "request body");
}

export function isConfigInput(value: unknown): value is AccountConfigInput {
  return isRecord(value) && Array.isArray(value.lists);
}

export function isPreviewRequest(value: unknown): value is PreviewRequest {
  return (
    isRecord(value) && isString(value.provider) && isString(value.sourceRef)
  );
}

/** The body of `POST /links/resolve`. */
export function isResolveRequest(
  value: unknown,
): value is { input: string; accountKey?: string; ticket?: string } {
  return isRecord(value) && isString(value.input);
}

/**
 * A configuration that the fixture serves. It can hold a value that the
 * answer type does not allow: `lastFetchedAt: null`.
 */
export type ServedConfig = Omit<AccountConfigResponse, "lastFetchedAt"> & {
  lastFetchedAt: string | null;
};

/**
 * Serve one Account's configuration and record every save. Saves succeed
 * and echo the submitted Lists (with `genres`), as the backend does, once
 * `gate` resolves. A load answers `state.config`, so the test can change the
 * configuration while the page is open. Registers no `baseRoutes`.
 */
export async function routeConfig(
  browser: Browser,
  initial: ServedConfig = configuration,
  key = accountId,
  options: { gate?: Promise<void>; genres?: string[] } = {},
) {
  const state = { config: initial };
  const submissions: AccountConfigInput[] = [];
  await browser.route(`${backend}/${key}/config`, async (route) => {
    if (route.request.method === "GET") {
      await route.fulfill({ json: toJson(state.config) });
    } else {
      const submitted = parseBody(route, isConfigInput);
      submissions.push(submitted);
      if (options.gate) await options.gate;
      await route.fulfill({
        json: toJson({
          ok: true,
          lists: savedLists(submitted, options.genres),
        }),
      });
    }
  });
  return { state, submissions };
}

/**
 * `baseRoutes`, then `routeConfig`: serve one Account's configuration and
 * return the recorded saves.
 */
export async function captureConfig(
  browser: Browser,
  initial: AccountConfigResponse = configuration,
  key = accountId,
) {
  await baseRoutes(browser);
  return (await routeConfig(browser, initial, key)).submissions;
}

/**
 * Answer the first save of a new setup (`POST /accounts`) as the backend
 * does: the fixture Account with the submitted Lists. Returns the saves.
 */
export async function routeCreateAccount(browser: Browser) {
  const created: AccountConfigInput[] = [];
  await browser.route(`${backend}/accounts`, async (route) => {
    const body = parseBody(route, isConfigInput);
    created.push(body);
    await route.fulfill({
      json: toJson({ ok: true, accountId, lists: savedLists(body) }),
    });
  });
  return created;
}

/**
 * `baseRoutes`, then serve `initial` and hold every save until the test
 * calls `release()`. Saves answer the submitted Lists with `genres`.
 */
export async function gatedSaves(
  browser: Browser,
  config: ServedConfig,
  genres?: string[],
) {
  await baseRoutes(browser);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { submissions } = await routeConfig(browser, config, accountId, {
    gate,
    genres,
  });
  return { submissions, release: () => release() };
}

/** A successful `/links/resolve` answer. */
export function resolved(
  provider: ProviderId,
  sourceRef: string,
  kind: string,
  extra: { suggestedTitle?: string; defaultDisplayMode?: string } = {},
) {
  return {
    ok: true,
    provider,
    sourceRef,
    kind,
    requiresConnection: false,
    suggestedTitle: extra.suggestedTitle ?? null,
    defaultDisplayMode: extra.defaultDisplayMode ?? null,
  };
}

/**
 * Answer `/links/resolve` with `answer(input)`; `null` aborts the request
 * like a network failure. Returns the submitted inputs.
 */
export async function routeResolve(
  browser: Browser,
  answer: (input: string, accountKey?: string) => object | null,
) {
  const inputs: { input: string; accountKey?: string }[] = [];
  await browser.route(`${backend}/links/resolve`, async (route) => {
    const body = parseBody(route, isResolveRequest);
    inputs.push(body);
    const json = answer(body.input, body.accountKey);
    if (json === null) await route.abort();
    else await route.fulfill({ json: toJson(json) });
  });
  return inputs;
}

/**
 * Answer `POST /lists/preview` with `answer(request, index)`; `null` aborts
 * like a network failure. Returns the submitted requests.
 */
export async function routePreview(
  browser: Browser,
  answer: (
    request: PreviewRequest,
    index: number,
  ) => CatalogPreviewResponse | null,
) {
  const requests: PreviewRequest[] = [];
  await browser.route(`${backend}/lists/preview`, async (route) => {
    const request = parseBody(route, isPreviewRequest);
    requests.push(request);
    const json = answer(request, requests.length - 1);
    if (json === null) await route.abort();
    else await route.fulfill({ json: toJson(json) });
  });
  return requests;
}

/**
 * Answer the Source lists of the `provider` Connection of `key` (Quick add
 * asks for them) with `sources`, none by default.
 */
export async function routeConnectionSources(
  browser: Browser,
  provider: ProviderId = "trakt",
  sources: object[] = [],
  key = accountId,
) {
  await browser.route(
    `${backend}/${key}/connections/${provider}/sources`,
    async (route) => {
      await route.fulfill({ json: toJson({ sources }) });
    },
  );
}

/**
 * Record the starts of a Trakt authorization of the fixture Account and end
 * them on a fixture page (`${backend}/authorize-fixture`). Returns the
 * request methods.
 */
export async function routeConnectStart(browser: Browser) {
  const starts: string[] = [];
  await browser.route(
    `${backend}/${accountId}/connections/trakt/start`,
    async (route) => {
      starts.push(route.request.method);
      await route.fulfill({
        json: {
          ok: true,
          authorizeUrl: `${backend}/authorize-fixture`,
          browserKey: "fixture-browser-key",
        },
      });
    },
  );
  await browser.route(`${backend}/authorize-fixture`, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<h1>Trakt authorization fixture</h1>",
    });
  });
  return starts;
}

export const MINUTE = 60_000;

/** The ISO time `ms` milliseconds ago. */
export const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Drag the second List above the first one with the pointer. */
export async function dragSecondAboveFirst(browser: Browser) {
  const handles = await browser.evaluate(() =>
    Array.from(
      document.querySelectorAll('[aria-label^="Drag to reorder"]'),
    ).map((el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }),
  );
  await browser.mouse.move(handles[1].x, handles[1].y);
  await browser.mouse.down();
  for (let step = 1; step <= 12; step += 1) {
    await browser.mouse.move(
      handles[1].x,
      handles[1].y + ((handles[0].y - handles[1].y - 20) * step) / 12,
    );
  }
  await browser.mouse.up();
}
