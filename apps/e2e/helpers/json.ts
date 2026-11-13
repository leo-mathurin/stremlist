// Readers of JSON that the tests do not type: HTTP answers, fixture files and
// logged requests. A guard checks the fields that tell its shape apart; a
// value that fails it fails the test with the value in the message.

export type Guard<T> = (value: unknown) => value is T;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

/** The field `key` of a JSON object, or undefined. */
export function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** An absent field, or one that `is` accepts. */
export function optional(
  value: unknown,
  is: (value: unknown) => boolean,
): boolean {
  return value === undefined || is(value);
}

/** `value` when `is` accepts it; any other value fails with `what`. */
export function parsed<T>(value: unknown, is: Guard<T>, what: string): T {
  if (!is(value)) {
    throw new Error(`Unexpected ${what}: ${JSON.stringify(value)}`);
  }
  return value;
}

/** The JSON text `text` as checked by `is`. */
export function parseJson<T>(text: string, is: Guard<T>, what: string): T {
  return parsed(JSON.parse(text), is, what);
}

/** `value` when it is present; null or undefined fails with `what`. */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what}, got ${String(value)}`);
  }
  return value;
}
