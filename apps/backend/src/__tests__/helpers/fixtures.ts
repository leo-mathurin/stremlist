import type { Tables } from "@stremlist/shared/database.types";
import type { ProviderId } from "@stremlist/shared/providers";
import type { StremioMeta } from "@stremlist/shared/stremio.types";
import { encryptSecret } from "../../lib/crypto";
import { db } from "./mock-supabase";

/** A fixed 32-byte key, so tests never depend on the real environment. */
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

export function useTestEncryptionKey(): void {
  process.env.CONNECTION_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
}

export const LIST_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
] as const;

export function seedAccount(
  overrides: Partial<Tables<"accounts">> = {},
): Tables<"accounts"> {
  return db.insert("accounts", overrides) as Tables<"accounts">;
}

/** An Account that Stremio reaches through its Legacy alias. */
export function seedLegacyAccount(
  imdbUserId: string,
  overrides: Partial<Tables<"accounts">> = {},
): Tables<"accounts"> {
  return seedAccount({ legacy_imdb_user_id: imdbUserId, ...overrides });
}

export function seedList(
  accountId: string,
  overrides: Partial<Tables<"lists">> & { source_ref: string },
): Tables<"lists"> {
  return db.insert("lists", {
    account_id: accountId,
    provider: "imdb",
    ...overrides,
  }) as Tables<"lists">;
}

export interface ConnectionSeed {
  accessToken?: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  username?: string | null;
}

/** A Connection stored the way saveConnection stores it (encrypted). */
export function seedConnection(
  accountId: string,
  provider: ProviderId,
  seed: ConnectionSeed = {},
): Tables<"connections"> {
  useTestEncryptionKey();
  const refreshToken =
    seed.refreshToken === undefined ? "refresh-token" : seed.refreshToken;
  return db.insert("connections", {
    account_id: accountId,
    provider,
    provider_username: seed.username === undefined ? "leo" : seed.username,
    access_token: encryptSecret(seed.accessToken ?? "access-token"),
    refresh_token: refreshToken ? encryptSecret(refreshToken) : null,
    expires_at:
      seed.expiresAt === undefined
        ? new Date(Date.now() + 24 * 60 * 60_000).toISOString()
        : (seed.expiresAt?.toISOString() ?? null),
  }) as Tables<"connections">;
}

export function movie(
  id: string,
  overrides: Partial<StremioMeta> = {},
): StremioMeta {
  return {
    id,
    type: "movie",
    name: `Movie ${id}`,
    poster: null,
    posterShape: "poster",
    genres: [],
    description: "",
    ...overrides,
  };
}
