import { expect as valueExpect } from "e2e";
import type { Locator, Page } from "./integration-browser.js";

type Text = string | RegExp;
type Options = { timeout?: number };
const readTimeout = { timeout: 750 };

function matches(value: string | null, expected: Text) {
  return (
    value !== null &&
    (typeof expected === "string"
      ? value === expected
      : new RegExp(expected).test(value))
  );
}

function normalize(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}

function check(
  read: () => boolean | Promise<boolean>,
  label: string,
  negated: boolean,
  options?: Options,
) {
  return valueExpect
    .poll(read, { message: label, timeout: options?.timeout ?? 20_000 })
    .toBe(!negated);
}

function locatorMatchers(locator: Locator, negated: boolean) {
  function assert(
    label: string,
    read: () => boolean | Promise<boolean>,
    options?: Options,
  ) {
    return check(
      read,
      `${String(locator)}: ${negated ? "not " : ""}${label}`,
      negated,
      options,
    );
  }

  return {
    toBeVisible: (options?: Options) =>
      assert("visible", () => locator.isVisible(), options),
    toBeAttached: (options?: Options) =>
      assert("attached", async () => (await locator.count()) === 1, options),
    toBeEnabled: () => assert("enabled", () => locator.isEnabled(readTimeout)),
    toBeDisabled: () =>
      assert("disabled", () => locator.isDisabled(readTimeout)),
    toBeChecked: () => assert("checked", () => locator.isChecked(readTimeout)),
    toBeFocused: () =>
      assert("focused", () =>
        locator.evaluate(
          (element) => element === element.ownerDocument.activeElement,
          undefined,
          readTimeout,
        ),
      ),
    toBeInViewport: () =>
      assert("in viewport", () =>
        locator.evaluate(
          (element) =>
            new Promise<boolean>((resolve) => {
              const observer = new IntersectionObserver(([entry]) => {
                observer.disconnect();
                resolve(entry.intersectionRatio > 0);
              });
              observer.observe(element);
            }),
          undefined,
          readTimeout,
        ),
      ),
    toHaveCount: (expected: number) =>
      assert(
        `count ${String(expected)}`,
        async () => (await locator.count()) === expected,
      ),
    toHaveValue: (expected: Text) =>
      assert(`value ${String(expected)}`, async () =>
        matches(await locator.inputValue(readTimeout), expected),
      ),
    toHaveClass: (expected: Text) =>
      assert(`class ${String(expected)}`, async () =>
        matches(await locator.getAttribute("class", readTimeout), expected),
      ),
    toHaveAttribute: (name: string, expected?: Text) =>
      assert(`attribute ${name} ${String(expected ?? "")}`, async () => {
        const attribute = await locator.getAttribute(name, readTimeout);
        return expected === undefined
          ? attribute !== null
          : matches(attribute, expected);
      }),
    toHaveText: (expected: Text | readonly Text[]) =>
      assert(`text ${String(expected)}`, async () => {
        if (typeof expected === "string" || expected instanceof RegExp) {
          return matches(
            normalize(await locator.innerText(readTimeout)),
            expected,
          );
        }
        const actual = await locator.allTextContents();
        return (
          actual.length === expected.length &&
          expected.every((text, index) =>
            matches(normalize(actual[index]), text),
          )
        );
      }),
    toContainText: (expected: string) =>
      assert(`text containing ${String(expected)}`, async () =>
        normalize(await locator.innerText(readTimeout)).includes(
          normalize(expected),
        ),
      ),
  };
}

function pageMatchers(page: Page) {
  return {
    toHaveURL: (expected: Text | ((url: URL) => boolean)) =>
      check(
        () =>
          typeof expected === "function"
            ? expected(new URL(page.url()))
            : matches(page.url(), expected),
        `URL ${String(expected)}`,
        false,
      ),
  };
}

function isLocator(value: unknown): value is Locator {
  return (
    typeof value === "object" &&
    value !== null &&
    "allTextContents" in value &&
    "boundingBox" in value
  );
}

function isPage(value: unknown): value is Page {
  return (
    typeof value === "object" &&
    value !== null &&
    "goto" in value &&
    "waitForResponse" in value
  );
}

function valueMatchers<T>(actual: T, message?: string) {
  return valueExpect(actual, message);
}

type LocatorMatchers = ReturnType<typeof locatorMatchers>;
function assert(actual: Locator): LocatorMatchers & { not: LocatorMatchers };
function assert(actual: Page): ReturnType<typeof pageMatchers>;
function assert<T>(
  actual: T,
  message?: string,
): ReturnType<typeof valueMatchers<T>>;
function assert(actual: unknown, message?: string) {
  if (isLocator(actual))
    return {
      ...locatorMatchers(actual, false),
      not: locatorMatchers(actual, true),
    };
  if (isPage(actual)) return pageMatchers(actual);
  return valueMatchers(actual, message);
}

export const expect = Object.assign(assert, valueExpect);
