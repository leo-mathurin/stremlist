import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { BACKEND_URL, FRONTEND_URL } from "../env.js";

let child: ChildProcess;
let providerBackend: string;

test.beforeAll(async () => {
  child = spawn(
    "bun",
    [
      "--no-env-file",
      "--preload",
      fileURLToPath(
        new URL("../helpers/provider-transport.ts", import.meta.url),
      ),
      "src/dev.ts",
    ],
    {
      cwd: fileURLToPath(new URL("../../backend/", import.meta.url)),
      env: {
        PATH: process.env.PATH,
        PORT: "0",
        HOST: "127.0.0.1",
        SUPABASE_URL: "http://127.0.0.1:1",
        SUPABASE_SERVICE_ROLE_KEY: "fixture-only",
        RESEND_API_KEY: "re_fixture_only",
        RESEND_AUDIENCE_ID: "fixture-audience",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  providerBackend = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Provider test backend did not start")),
      20_000,
    );
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const port = output.match(
        /backend running on http:\/\/localhost:(\d+)/,
      )?.[1];
      if (port) {
        clearTimeout(timeout);
        resolve(`http://127.0.0.1:${port}`);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Provider backend exited (${code})`));
    });
    // Drain diagnostics without exposing headers, API keys or request contents.
    child.stderr?.resume();
  });
});
test.afterAll(async () => {
  if (child && child.exitCode === null) {
    await new Promise<void>((resolve, reject) => {
      const force = setTimeout(() => child.kill("SIGKILL"), 3_000);
      const deadline = setTimeout(() => {
        child.unref();
        reject(new Error("Provider backend did not exit after SIGKILL"));
      }, 6_000);
      child.once("exit", () => {
        clearTimeout(force);
        clearTimeout(deadline);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
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
        `${providerBackend}/newsletter/subscribe`,
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
        url: `${providerBackend}/newsletter/subscribe`,
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
  ["ls99000001", { valid: true }],
  ["ls99000002", { valid: false, reason: "private" }],
  ["ls99000003", { valid: false, reason: "private" }],
  ["ls99000004", { valid: false, reason: "not_found" }],
] as const) {
  test(
    `IMDb list ${id} is classified through the real GraphQL transport`,
    { tag: "@local" },
    async ({ request }) => {
      const response = await request.get(
        `${providerBackend}/validate-list/${id}`,
      );
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual(expected);
    },
  );
}
