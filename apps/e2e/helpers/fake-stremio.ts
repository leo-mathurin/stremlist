// The Stremio account that the fake Stremio API of watch-fixtures.ts serves:
// a JSON file that watch-tracking.spec.ts writes and the backend reads.
import { isRecord, isString } from "./json.js";

export interface FakeStremio {
  authKey: string;
  /** Stremio's own Trakt integration is connected. */
  trakt: boolean;
  library: Record<string, unknown>[];
  addons: Record<string, unknown>[];
}

export function isFakeStremio(value: unknown): value is FakeStremio {
  return (
    isRecord(value) &&
    isString(value.authKey) &&
    typeof value.trakt === "boolean" &&
    Array.isArray(value.library) &&
    value.library.every(isRecord) &&
    Array.isArray(value.addons) &&
    value.addons.every(isRecord)
  );
}
