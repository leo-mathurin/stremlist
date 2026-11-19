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
export function field(value: unknown, key: string) {
  return isRecord(value) ? value[key] : undefined;
}

/** An absent field, or one that `is` accepts. */
export function optional(value: unknown, is: (value: unknown) => boolean) {
  return value === undefined || is(value);
}

/** `value` when `is` accepts it; any other value fails with `what`. */
export function parsed<T>(value: unknown, is: Guard<T>, what: string) {
  if (!is(value)) {
    throw new Error(`Unexpected ${what}: ${JSON.stringify(value)}`);
  }
  return value;
}

/** The JSON text `text` as checked by `is`. */
export function parseJson<T>(text: string, is: Guard<T>, what: string) {
  return parsed(JSON.parse(text), is, what);
}

/** `value` when it is present; null or undefined fails with `what`. */
export function present<T>(value: T | null | undefined, what: string) {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what}, got ${String(value)}`);
  }
  return value;
}
