import { expect, test } from "@playwright/test";
import { BACKEND_URL, FRONTEND_URL } from "../env.js";
import type { ProviderBackend } from "../helpers/provider-backend.js";
import { startProviderBackend } from "../helpers/provider-backend.js";

let backend: ProviderBackend;

test.beforeAll(async () => {
  backend = await startProviderBackend("./provider-transport.ts", {
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-only",
    RESEND_API_KEY: "re_fixture_only",
    RESEND_AUDIENCE_ID: "fixture-audience",
  });
});
test.afterAll(async () => {
  await backend?.stop();
});

for (const [scenario, status, expected] of [
  ["success", 200, { success: true, contactId: "fixture-contact" }],
  [
    "duplicate",
    200,
    {
      success: true,
      message:
        "You're already subscribed! You'll be notified about new features and updates.",
    },
  ],
  ["invalid", 400, { success: false, error: "Invalid email address format." }],
  [
    "unauthorized",
    500,
    { success: false, error: "Newsletter service authentication failed." },
  ],
  [
    "unavailable",
    500,
    { success: false, error: "Failed to subscribe. Please try again later." },
  ],
  [
    "offline",
    500,
    { success: false, error: "Failed to subscribe. Please try again later." },
  ],
] as const) {
  test(
    `newsletter handler translates provider ${scenario}`,
    { tag: "@local" },
    async ({ request }) => {
      const response = await request.post(
        `${backend.url}/newsletter/subscribe`,
        { data: { email: `${scenario}@example.test` } },
      );
      expect(response.status()).toBe(status);
      expect(await response.json()).toMatchObject(expected);
    },
  );
}

test(
  "newsletter browser recovers through the real handler and isolated provider",
  { tag: "@local" },
  async ({ page }) => {
    // Forward only the newsletter endpoint to the real isolated handler. Other
    // frontend requests still use the standard local backend.
    await page.route(`${BACKEND_URL}/newsletter/subscribe`, async (route) => {
      const response = await route.fetch({
        url: `${backend.url}/newsletter/subscribe`,
      });
      await route.fulfill({ response });
    });
    await page.goto(FRONTEND_URL);
    await page
      .getByPlaceholder("your@email.com")
      .fill("unavailable@example.test");
    await page.getByRole("button", { name: "Subscribe", exact: true }).click();
    await expect(
      page.getByText("Failed to subscribe. Please try again later."),
    ).toBeVisible();
    await expect(page.getByPlaceholder("your@email.com")).toHaveValue(
      "unavailable@example.test",
    );
    await page.getByPlaceholder("your@email.com").fill("success@example.test");
    await page.getByRole("button", { name: "Subscribe", exact: true }).click();
    await expect(
      page.getByText(
        "Successfully subscribed! You'll be notified about new features and updates.",
      ),
    ).toBeVisible();
    await expect(page.getByPlaceholder("your@email.com")).toHaveValue("");
  },
);

for (const [id, expected] of [
  [
    "ls99000001",
    {
      ok: true,
      provider: "imdb",
      sourceRef: "ls99000001",
      kind: "list",
      requiresConnection: false,
      suggestedTitle: null,
      defaultDisplayMode: null,
    },
  ],
  ["ls99000002", { ok: false, reason: "private", provider: "imdb" }],
  ["ls99000003", { ok: false, reason: "private", provider: "imdb" }],
  ["ls99000004", { ok: false, reason: "not_found", provider: "imdb" }],
] as const) {
  test(
    `IMDb list ${id} is classified through the real GraphQL transport`,
    { tag: "@local" },
    async ({ request }) => {
      const response = await request.post(`${backend.url}/links/resolve`, {
        data: { input: `https://www.imdb.com/list/${id}/` },
      });
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual(expected);
    },
  );
}
