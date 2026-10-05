import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function encryptionKey(): Buffer {
  const encoded = process.env.CONNECTION_ENCRYPTION_KEY;
  if (!encoded) {
    throw new Error("Missing CONNECTION_ENCRYPTION_KEY environment variable");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error("CONNECTION_ENCRYPTION_KEY must be 32 bytes in base64");
  }
  return key;
}

/**
 * Encrypt a Connection secret (OAuth token) for storage. AES-256-GCM with a
 * random IV; the output is "v1:" + base64(iv | tag | ciphertext).
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  const [version, payload] = stored.split(":", 2);
  if (version !== VERSION || !payload) {
    throw new Error("Unknown secret format");
  }
  const raw = Buffer.from(payload, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    raw.subarray(0, IV_BYTES),
  );
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
}

/** URL-safe random string, for OAuth `state` and PKCE verifiers. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
