import { RuleTester } from "vite-plus/lint/plugins-dev";

import { noVitePlusTestDoublesRule } from "./no-vite-plus-test-doubles.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "replacement" };
const header = 'import { vi } from "vite-plus/test";\n';

tester.run("anti-slop/no-vite-plus-test-doubles", noVitePlusTestDoublesRule, {
  valid: [
    `${header}vi.spyOn(console, "error");`,
    `${header}const log = vi.spyOn(console, "log"); expect(log).toHaveBeenCalled();`,
    `${header}vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(0);`,
    `${header}vi.stubEnv("TRAKT_CLIENT_ID", "app"); vi.unstubAllEnvs();`,
    'import { vi } from "vitest"; vi.mock("./lib/supabase");',
    'const vi = { mock() {}, fn() {} }; vi.mock("./x"); vi.fn(() => 1);',
    'import { describe } from "vite-plus/test"; const vi = { fn() {} }; vi.fn();',
  ],
  invalid: [
    { name: "vi.mock", code: `${header}vi.mock("../lib/supabase", () => ({}));`, errors: [error] },
    { name: "vi.mock with spy", code: `${header}vi.mock("../lib/r2", { spy: true });`, errors: [error] },
    { name: "vi.doMock", code: `${header}vi.doMock("../lib/r2");`, errors: [error] },
    { name: "vi.stubGlobal", code: `${header}vi.stubGlobal("fetch", () => null);`, errors: [error] },
    { name: "vi.fn", code: `${header}const send = vi.fn();`, errors: [error] },
    { name: "vi.fn with an implementation", code: `${header}const send = vi.fn(() => 1);`, errors: [error] },
    { name: "vi.mocked", code: `${header}vi.mocked(send).mock.calls;`, errors: [error] },
    {
      name: "spyOn with mockImplementation",
      code: `${header}vi.spyOn(console, "error").mockImplementation(() => undefined);`,
      errors: [error],
    },
    {
      name: "spyOn with mockReturnValue",
      code: `${header}vi.spyOn(Math, "random").mockReturnValue(0.5);`,
      errors: [error],
    },
    {
      name: "spyOn with mockResolvedValue",
      code: `${header}const spy = vi.spyOn(api, "get"); spy.mockResolvedValue(1);`,
      errors: [error],
    },
    {
      name: "spyOn with mockRejectedValueOnce",
      code: `${header}vi.spyOn(api, "get").mockRejectedValueOnce(new Error("x"));`,
      errors: [error],
    },
    {
      name: "aliased import",
      code: 'import { vi as v } from "vite-plus/test"; v.stubGlobal("fetch", null);',
      errors: [error],
    },
    {
      name: "namespace import",
      code: 'import * as test from "vite-plus/test"; test.vi.mock("../lib/r2");',
      errors: [error],
    },
    {
      name: "computed member",
      code: `${header}vi["mock"]("../lib/r2");`,
      errors: [error],
    },
  ],
});
