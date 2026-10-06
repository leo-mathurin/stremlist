import type { Browser, WebRoute } from "@e2e-dev/web";
import type { ProviderId } from "@stremlist/shared/providers";
import { PROVIDER_IDS } from "@stremlist/shared/providers";
import type {
  AccountConfigInput,
  AccountConfigResponse,
  ConfigList,
} from "@stremlist/shared/stremio.types";

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
  "Saved! Reinstall Stremlist in Stremio to see your new catalogs and Actions.";
export const SAVED_WITH_CHANGES =
  "Saved the submitted settings. You have unsaved changes: save again to apply them.";

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

export const configuration = {
  access: "private",
  accountId,
  movedAt: null,
  rpdbApiKey: null,
  lists: [row],
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

/**
 * Register first: answers the requests every page makes (`/providers`,
 * `/stats`) and fails the test on any other request that a later, more
 * specific route did not take.
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
