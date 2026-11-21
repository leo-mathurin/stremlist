import { surfaceOf, test as webTest, web } from "@e2e-dev/web";
import { BACKEND_URL, STREMIO_WEB_URL } from "./env.js";

export const engine = web({
  viewport: { width: 1280, height: 720 },
  headers: {},
});

const surface = surfaceOf(engine);
if (!surface) throw new Error("Expected the e2e web engine");
const live = surface;

export type Page = ReturnType<typeof live.page>;
export type Locator = ReturnType<Page["locator"]>;
type Context = ReturnType<typeof live.context>;
export type CDPSession = Awaited<ReturnType<Context["newCDPSession"]>>;

export async function routeAddonRequests(context: Context, origin: string) {
  await context.route(
    (url) =>
      url.origin === origin &&
      /\/(?:manifest\.json$|(?:catalog|meta|stream)\/)/u.test(url.pathname),
    async (route) => {
      if (route.request().headers().origin !== STREMIO_WEB_URL) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        response: await route.fetch({ maxRedirects: 0 }),
      });
    },
  );
}

export const test = webTest.extend<{
  page: Page;
  context: Context;
  request: Context["request"];
}>({
  context: async (_, use) => use(live.context()),
  request: async (_, use) => use(live.context().request),
  page: async ({ browser }, use) => {
    const context = live.context();
    await routeAddonRequests(context, BACKEND_URL);
    const blank = "**/__e2e_blank__";
    await context.route(
      blank,
      (route) => route.fulfill({ contentType: "text/html", body: "" }),
      { times: 1 },
    );
    await browser.goto("/__e2e_blank__");
    const page = live.page();
    page.setDefaultTimeout(20_000);
    try {
      await use(page);
    } finally {
      await context.unrouteAll({ behavior: "wait" });
    }
  },
});

export async function emulatePhone(page: Page, scale = 1) {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: scale,
    mobile: true,
  });
  await session.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1,
  });
}

export async function tapOn(page: Page, locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("Touch target is not visible");
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await session.detach();
  }
}
