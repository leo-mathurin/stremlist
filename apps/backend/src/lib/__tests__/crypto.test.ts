import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, randomToken } from "../crypto";

const KEY = Buffer.alloc(32, 1).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 2).toString("base64");

function tamper(stored: string, index: number): string {
  const [version, payload] = stored.split(":");
  const raw = Buffer.from(payload, "base64");
  raw[index] ^= 0x01;
  return `${version}:${raw.toString("base64")}`;
}

describe("Connection secret encryption", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.CONNECTION_ENCRYPTION_KEY;
    process.env.CONNECTION_ENCRYPTION_KEY = KEY;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.CONNECTION_ENCRYPTION_KEY;
    else process.env.CONNECTION_ENCRYPTION_KEY = saved;
  });

  it.each(["access-token", "", "é🔑 unicode", "x".repeat(4096)])(
    "round-trips %j",
    (secret) => {
      expect(decryptSecret(encryptSecret(secret))).toBe(secret);
    },
  );

  it("never stores the plaintext and uses a fresh IV each time", () => {
    const first = encryptSecret("access-token");
    const second = encryptSecret("access-token");

    expect(first).toMatch(/^v1:[A-Za-z0-9+/]+=*$/);
    expect(first).not.toContain("access-token");
    expect(
      Buffer.from(first.slice(3), "base64").toString("utf8"),
    ).not.toContain("access-token");
    expect(first).not.toBe(second);
  });

  it.each([
    ["the IV", 0],
    ["the auth tag", 12],
    ["the ciphertext", 28],
  ])("detects a change to %s", (_part, index) => {
    const stored = encryptSecret("access-token");
    expect(() => decryptSecret(tamper(stored, index))).toThrow();
  });

  it("does not decrypt with another key", () => {
    const stored = encryptSecret("access-token");
    process.env.CONNECTION_ENCRYPTION_KEY = OTHER_KEY;
    expect(() => decryptSecret(stored)).toThrow();
  });

  it.each(["plaintext", "v2:abcd", "v1:", ""])(
    "rejects the unknown format %j",
    (stored) => {
      expect(() => decryptSecret(stored)).toThrow();
    },
  );

  it("refuses to work without a key", () => {
    delete process.env.CONNECTION_ENCRYPTION_KEY;
    expect(() => encryptSecret("access-token")).toThrow(
      "Missing CONNECTION_ENCRYPTION_KEY environment variable",
    );
  });

  it.each([
    ["too short", Buffer.alloc(16, 1).toString("base64")],
    ["too long", Buffer.alloc(48, 1).toString("base64")],
  ])("refuses a key that is %s", (_label, key) => {
    process.env.CONNECTION_ENCRYPTION_KEY = key;
    expect(() => encryptSecret("access-token")).toThrow(
      "CONNECTION_ENCRYPTION_KEY must be 32 bytes in base64",
    );
  });
});

describe("randomToken", () => {
  it("is URL-safe and unique", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => randomToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is long enough for a PKCE verifier (43 to 128 characters)", () => {
    expect(randomToken(48)).toHaveLength(64);
  });
});
