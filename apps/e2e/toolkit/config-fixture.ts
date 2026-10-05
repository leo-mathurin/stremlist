import type { Browser } from "@e2e-dev/web";
import type {
  ConfigWatchlist,
  UserConfigResponse,
  UserConfigUpdatePayload,
} from "@stremlist/shared/stremio.types";

export const account = "ur99123456";
export const backend = "http://127.0.0.1:4314";
export const sourcePlaceholder = "ur12345678, p.colneedham, or ls593621567";
export const titlePlaceholder = "Tom Hardy's Watchlist";
export const row = {
  id: "00000000-0000-4000-8000-000000000001",
  imdbUserId: account,
  catalogTitle: "Test catalog",
  sortOption: "added_at-asc",
  displayMode: "split",
  position: 0,
  catalogSettings: {},
  availableGenres: ["Drama", "Comedy"],
} satisfies ConfigWatchlist;
export const configuration = {
  rpdbApiKey: null,
  lastFetchedAt: "2020-01-01T00:00:00.000Z",
  cooldownSeconds: 2,
  watchlists: [row],
} satisfies UserConfigResponse;

// This fixture records requests. Real storage/manifest behavior is covered by
// configuration-transitions.spec.ts rather than reimplemented in this mock.
export async function captureConfig(browser: Browser, initial = configuration) {
  const submissions: UserConfigUpdatePayload[] = [];
  await browser.route(`${backend}/${account}/config`, async (route) => {
    if (route.request.method === "GET") {
      await route.fulfill({
        body: JSON.stringify(initial),
        contentType: "application/json",
      });
    } else {
      const submitted: UserConfigUpdatePayload = JSON.parse(
        route.request.postData ?? "{}",
      );
      submissions.push(submitted);
      await route.fulfill({ json: { ok: true } });
    }
  });
  return submissions;
}
