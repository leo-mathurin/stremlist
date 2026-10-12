/** Resend for tests: `vi.mock("…/lib/resend", () => import("…/mock-resend"))`. */
import { vi } from "vitest";
import type { Mock } from "vitest";

export const resend: { contacts: { create: Mock } } = {
  contacts: { create: vi.fn() },
};
