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
    'import { expect } from "vite-plus/test"; const stub = make(); stub.mockReturnValue(1);',
    'import { expect } from "vite-plus/test"; recorder.mockImplementation(() => 1);',
    `${header}function run(vi: { mock(path: string): void }) { vi.mock("./x"); }`,
    `${header}{ const vi = { stubGlobal() {} }; vi.stubGlobal(); }`,
    `${header}const spy = vi.spyOn(console, "log"); { const spy = make(); spy.mockReturnValue(1); }`,
    `${header}const useTimers = vi.useFakeTimers; useTimers();`,
    `${header}const { spyOn } = vi; spyOn(console, "warn");`,
    `${header}const { mockReturnValue } = make(); mockReturnValue(1);`,
    `${header}const set = other.mockReturnValue; set(1);`,
    `${header}const spy = vi.spyOn(dep, "read"); { const mockReturnValue = make; mockReturnValue(1); }`,
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
      name: "alias of a vi method",
      code: `${header}const mock = vi.mock; mock("../lib/r2");`,
      errors: [error],
    },
    {
      name: "alias of an alias",
      code: `${header}const stub = vi.stubGlobal; const again = stub; again("fetch", null);`,
      errors: [error],
    },
    {
      name: "destructured vi method",
      code: `${header}const { fn } = vi; const send = fn();`,
      errors: [error],
    },
    {
      name: "destructured and renamed vi method",
      code: `${header}const { doMock: replace } = vi; replace("../lib/r2");`,
      errors: [error],
    },
    {
      name: "alias of vi",
      code: `${header}const v = vi; v.mock("../lib/r2");`,
      errors: [error],
    },
    {
      name: "vi destructured from the namespace",
      code: 'import * as test from "vite-plus/test"; const { vi } = test; vi.stubGlobal("fetch", null);',
      errors: [error],
    },
    {
      name: "setter on a stored spy from a destructured spyOn",
      code: `${header}const { spyOn } = vi; const spy = spyOn(api, "get"); spy.mockReturnValue(1);`,
      errors: [error],
    },
    {
      name: "chained setters",
      code: `${header}vi.spyOn(api, "get").mockReturnValueOnce(1).mockReturnValue(2);`,
      errors: [error, error],
    },
    {
      name: "vi.mockObject",
      code: `${header}const api = vi.mockObject({ get: () => 1 });`,
      errors: [error],
    },
    {
      name: "aliased vi.mockObject",
      code: `${header}const { mockObject } = vi; const api = mockObject({ get: () => 1 });`,
      errors: [error],
    },
    {
      name: "vi.mockObject through an alias of vi",
      code: `${header}const v = vi; const replace = v.mockObject; replace({});`,
      errors: [error],
    },
    {
      name: "destructured setter of a spy",
      code: `${header}const spy = vi.spyOn(dep, "read"); const { mockReturnValue } = spy; mockReturnValue(1);`,
      errors: [error],
    },
    {
      name: "renamed destructured setter",
      code: `${header}const { mockImplementation: replace } = vi.spyOn(dep, "read"); replace(() => 1);`,
      errors: [error],
    },
    {
      name: "aliased setter",
      code: `${header}const spy = vi.spyOn(dep, "read"); const set = spy.mockReturnValue; set(1);`,
      errors: [error],
    },
    {
      name: "alias of an aliased setter",
      code: `${header}const set = vi.spyOn(dep, "read").mockResolvedValue; const again = set; again(1);`,
      errors: [error],
    },
    {
      name: "computed member",
      code: `${header}vi["mock"]("../lib/r2");`,
      errors: [error],
    },
  ],
});
