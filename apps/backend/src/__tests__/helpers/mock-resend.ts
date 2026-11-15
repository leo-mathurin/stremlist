/** Resend for tests: `vi.mock("…/lib/resend", () => import("…/mock-resend"))`. */
import { vi } from "vite-plus/test";
import type { resend as realResend } from "../../lib/resend";

export const resend = {
  contacts: { create: vi.fn<typeof realResend.contacts.create>() },
};
