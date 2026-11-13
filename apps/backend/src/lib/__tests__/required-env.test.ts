import { describe, expect, it } from "vitest";
import { assertRequiredEnv, missingEnv } from "../required-env";

const complete = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "key",
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "access",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "bucket",
  CONNECTION_ENCRYPTION_KEY: "encryption-key",
};

describe("missingEnv", () => {
  it("accepts a complete environment", () => {
    expect(missingEnv(complete)).toEqual([]);
  });

  it("lists every missing or blank variable", () => {
    expect(
      missingEnv({ ...complete, R2_BUCKET: " ", R2_ACCOUNT_ID: undefined }),
    ).toEqual(["R2_BUCKET", "R2_ACCOUNT_ID"]);
  });

  it("accepts R2_ENDPOINT in place of R2_ACCOUNT_ID", () => {
    expect(
      missingEnv({
        ...complete,
        R2_ACCOUNT_ID: undefined,
        R2_ENDPOINT: "http://127.0.0.1:7431",
      }),
    ).toEqual([]);
  });
});

describe("assertRequiredEnv", () => {
  it("names the missing variables", () => {
    expect(() => {
      assertRequiredEnv({ ...complete, SUPABASE_URL: undefined });
    }).toThrow("Missing environment variables: SUPABASE_URL.");
  });
});
