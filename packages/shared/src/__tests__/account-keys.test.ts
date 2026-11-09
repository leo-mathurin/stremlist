import { describe, expect, it } from "vitest";
import {
  ACCOUNT_KEY_PATTERN,
  IMDB_USER_ID_PATTERN,
  LEGACY_ALIAS_PATTERN,
} from "../constants";

// The key shapes that production holds as `legacy_imdb_user_id`.
const V1_KEYS = [
  "ur12345678",
  "ur12",
  "p.Ab3dEf9hIjkLmn0pQrStuvWxyz",
  "p.someone",
  "ls123456789",
  "ur12345678ls123456789",
];
const JUNK_KEYS = [
  "123",
  "potato",
  "YOUR_IMDB_ID",
  "ur12345678'--",
  "UR12345678",
  "p.",
  "ls12ab",
  "sl_short",
  "",
];

describe("Addon URL keys", () => {
  it.each(V1_KEYS)("accept the v1 key %j as a Legacy alias", (key) => {
    expect(LEGACY_ALIAS_PATTERN.test(key)).toBe(true);
    expect(ACCOUNT_KEY_PATTERN.test(key)).toBe(true);
  });

  it("accept a generated Account ID, which is no Legacy alias", () => {
    const id = "sl_E2eFixtureAccount00001";
    expect(ACCOUNT_KEY_PATTERN.test(id)).toBe(true);
    expect(LEGACY_ALIAS_PATTERN.test(id)).toBe(false);
  });

  it.each(JUNK_KEYS)("refuse the junk key %j", (key) => {
    expect(ACCOUNT_KEY_PATTERN.test(key)).toBe(false);
  });

  it("create installs only for the forms that v1 still created", () => {
    expect(V1_KEYS.filter((key) => IMDB_USER_ID_PATTERN.test(key))).toEqual([
      "ur12345678",
      "p.Ab3dEf9hIjkLmn0pQrStuvWxyz",
      "p.someone",
    ]);
  });
});
