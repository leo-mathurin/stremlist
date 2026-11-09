import type { Page } from "@playwright/test";
import { BACKEND_URL } from "../env.js";

/**
 * Send every API request of the page to the backend at `url` (a fixture
 * backend) instead of the Playwright backend. Both use the same database,
 * so Accounts that the page creates exist on both.
 */
export async function routePageTo(page: Page, url: string): Promise<void> {
  await page.route(`${BACKEND_URL}/**`, async (route) => {
    const target = new URL(route.request().url());
    const response = await route.fetch({
      url: `${url}${target.pathname}${target.search}`,
    });
    await route.fulfill({ response });
  });
}
