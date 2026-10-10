import type { Browser, WebRoute } from "@e2e-dev/web";
import type {
  CatalogPreview,
  CatalogPreviewRow,
} from "@stremlist/shared/catalog-preview";
import type { CatalogSettings } from "@stremlist/shared/catalog-settings";
import type { DisplayMode } from "@stremlist/shared/constants";
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

// Intercepted API of the configure page. These fixtures record requests and
// prove UI state; real storage and manifest behavior is covered by the
// Playwright integration specs rather than reimplemented here.

export const backend = "http://127.0.0.1:4314";
/** A private Account ID (`sl_` and 22 base62 characters). */
export const accountId = "sl_E2eFixtureAccount00001";
export const secondAccountId = "sl_E2eFixtureAccount00002";
/** The IMDb watchlist of the fixture List; also a Legacy alias. */
export const imdbUser = "ur99123456";

export const SAVED = "Saved! Your catalogs will refresh with the new settings.";
export const SAVED_REINSTALL =
  "Saved! Reinstall Stremlist in Stremio to see your changes.";
export const SAVED_WITH_CHANGES =
  "Saved the submitted settings. You have unsaved changes: save again to apply them.";

/** The label of the Save button before the first save creates the Account. */
export const SAVE_NEW = "Save and get my Addon URL";

/**
 * The Save button at the top of the Lists column. The floating Save button
 * at the bottom has the same name and stays in the page while it is hidden,
 * so take the first one.
 */
export function saveButton(screen: Screen, name = "Save") {
  return screen.getByRole("button", name, { exact: true }).first();
}

/**
 * Keeps toasts on screen until they are replaced or closed. Save and
 * newsletter results are toasts that close after 6 to 10 seconds, and an AI
 * goal can take longer than that to finish, so a check of the toast after the
 * goal could find it gone. Sonner pauses its timers while the document is
 * hidden, so the page reports a hidden document.
 */
export async function holdToasts(browser: Browser) {
  await browser.addInitScript(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
  });
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

/** A Connection that the Provider accepts. */
export function connected(
  provider: ProviderId,
  username: string | null = "someone",
): ConnectionSummary {
  return {
    provider,
    username,
    connectedAt: "2026-10-01T00:00:00.000Z",
    needsRenewalSince: null,
  };
}

export const configuration = {
  access: "private",
  accountId,
  movedAt: null,
  rpdbApiKey: null,
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
} satisfies AccountConfigResponse;

/** The same Account seen through its Legacy alias (ADR 0001). */
export const legacyConfiguration = {
  ...configuration,
  access: "legacy",
  accountId: null,
} satisfies AccountConfigResponse;

/** `GET /providers`: every Provider on, OAuth configured where it exists. */
export function providerStatus(
  overrides: Partial<
    Record<ProviderId, { enabled?: boolean; connectable?: boolean }>
  > = {},
) {
  return {
    providers: PROVIDER_IDS.map((id) => ({
      id,
      enabled: overrides[id]?.enabled ?? true,
      connectable:
        overrides[id]?.connectable ??
        ["trakt", "simkl", "mdblist"].includes(id),
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
}

/**
 * A Catalog preview for `request`: two movies, no series and no Unresolved
 * entries, unless `overrides` says otherwise. Posters are null, so no image
 * request leaves the test.
 */
export function previewOf(
  request: Pick<PreviewRequest, "displayMode">,
  overrides: Partial<CatalogPreview> = {},
): CatalogPreview {
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
  return {
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
}

/**
 * Register first: answers the requests every page makes (`/providers`,
 * `/stats`, the `/sync-status` poll), and the Catalog preview that an added
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
    // Tests that check sync states route the poll themselves.
    else if (pathname.endsWith("/sync-status"))
      await route.fulfill({
        json: toJson({
          syncStatus: configuration.syncStatus,
          connections: [],
        }),
      });
    else if (pathname === "/lists/preview" && route.request.method === "POST")
      await route.fulfill({
        json: toJson(previewOf(parseBody<PreviewRequest>(route))),
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
): ConfigList[] {
  return submitted.lists.map((list, index) => ({
    catalogTitle: "",
    displayMode: "split",
    ...list,
    id: list.id ?? `00000000-0000-4000-8000-00000000010${index}`,
    position: index,
    availableGenres: genres,
  }));
}

type Json = NonNullable<Parameters<WebRoute["fulfill"]>[0]["json"]>;

/** Typed fixtures as a route body (interfaces are not JSON-typed). */
export function toJson(value: object): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

export function parseBody<T>(route: WebRoute): T {
  return JSON.parse(route.request.postData ?? "{}") as T;
}

/**
 * Serve one Account's configuration and record every save. Saves succeed
 * and echo the submitted Lists, as the backend does.
 */
export async function captureConfig(
  browser: Browser,
  initial: AccountConfigResponse = configuration,
  key = accountId,
) {
  await baseRoutes(browser);
  const submissions: AccountConfigInput[] = [];
  await browser.route(`${backend}/${key}/config`, async (route) => {
    if (route.request.method === "GET") {
      await route.fulfill({ json: toJson(initial) });
    } else {
      const submitted = parseBody<AccountConfigInput>(route);
      submissions.push(submitted);
      await route.fulfill({
        json: toJson({ ok: true, lists: savedLists(submitted) }),
      });
    }
  });
  return submissions;
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
    const body = parseBody<{ input: string; accountKey?: string }>(route);
    inputs.push(body);
    const json = answer(body.input, body.accountKey);
    if (json === null) await route.abort();
    else await route.fulfill({ json: json as never });
  });
  return inputs;
}

/** Centers of the List drag handles, in visible order. */
export async function dragHandleCenters(browser: Browser) {
  return browser.evaluate(() =>
    Array.from(
      document.querySelectorAll('[aria-label^="Drag to reorder"]'),
    ).map((el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }),
  );
}

/** Drag the second List above the first one with the pointer. */
export async function dragSecondAboveFirst(browser: Browser) {
  const handles = await dragHandleCenters(browser);
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
