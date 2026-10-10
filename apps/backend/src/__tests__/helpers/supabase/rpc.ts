import type { Result } from "./store";

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
