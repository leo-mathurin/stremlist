import { isRecord } from "../json";
import type { Result, Row } from "./store";

export type RpcArgs = Record<string, unknown>;
export type RpcHandler = (args: RpcArgs) => Result | Promise<Result>;

export function rpcError(message: string): Result {
  return { data: null, error: { message } };
}

export function secondsFromNow(
  seconds: number,
  min: number,
  max: number,
): string {
  const clamped = Math.min(Math.max(seconds, min), max);
  return new Date(Date.now() + clamped * 1000).toISOString();
}

/** A number argument or column; anything else is a bug in the caller. */
export function numberOf(value: unknown, what: string): number {
  if (typeof value !== "number") throw new Error(`${what} must be a number`);
  return value;
}

/** A text[] argument that SQL NULL leaves empty. */
export function stringsOf(value: unknown, what: string): string[] {
  if (value === null || value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string => typeof item === "string")
  ) {
    throw new Error(`${what} must be an array of strings`);
  }
  return value;
}

/** A json argument that holds one row. */
export function rowOf(value: unknown, what: string): Row {
  if (!isRecord(value)) throw new Error(`${what} must be an object`);
  return value;
}
