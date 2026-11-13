import type { ProviderId } from "@stremlist/shared/providers";
import { z } from "zod";
import { createHash } from "node:crypto";
import { randomToken } from "../lib/crypto";
import { supabase } from "../lib/supabase";
import { providerFetch } from "../providers/http";
import { getProvider } from "../providers/registry";
import type { OAuthConfig } from "../providers/types";

const STATE_TTL_MS = 15 * 60_000;

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

export class OAuthNotConfiguredError extends Error {
  constructor(provider: ProviderId) {
    super(`OAuth is not configured for ${provider}`);
    this.name = "OAuthNotConfiguredError";
  }
}

function getOAuthConfig(provider: ProviderId): OAuthConfig {
  const config = getProvider(provider).oauth;
  if (!config?.clientId()) throw new OAuthNotConfiguredError(provider);
  return config;
}

export function isOAuthConfigured(provider: ProviderId): boolean {
  return !!getProvider(provider).oauth?.clientId();
}

/**
 * The callback URL registered with every Provider app, on the public origin
 * of this backend (`backendOrigin`).
 */
export function redirectUri(provider: ProviderId, origin: string): string {
  return `${origin}/oauth/${provider}/callback`;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function hashBrowserKey(browserKey: string): string {
  return createHash("sha256").update(browserKey).digest("base64url");
}

/**
 * Start an authorization: remember the PKCE verifier under a random state and
 * return the Provider's authorize URL. `accountId` is null for a new setup:
 * its Account is created only when the connection succeeds.
 *
 * The browser that starts the authorization keeps `browserKey` and must send
 * it to complete the authorization. Only its hash is stored. A consent link
 * that someone opens in another browser therefore links nothing (OAuth login
 * CSRF).
 */
export async function startAuthorization(
  accountId: string | null,
  provider: ProviderId,
  /** The public origin of this backend (`backendOrigin`). */
  origin: string,
): Promise<{ authorizeUrl: string; browserKey: string }> {
  const config = getOAuthConfig(provider);
  const state = randomToken();
  const verifier = randomToken(48);
  const browserKey = randomToken();

  const { error } = await supabase.from("oauth_states").insert({
    state,
    account_id: accountId,
    provider,
    code_verifier: verifier,
    browser_key_hash: hashBrowserKey(browserKey),
    expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });
  if (error) throw error;

  const url = new URL(config.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId() ?? "");
  url.searchParams.set("redirect_uri", redirectUri(provider, origin));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (config.scopes?.length)
    url.searchParams.set("scope", config.scopes.join(" "));
  return { authorizeUrl: url.toString(), browserKey };
}

/**
 * Look up and delete a pending authorization, only for the browser that
 * started it (`browserKey`). One use only. Another key leaves it pending.
 */
export async function consumeState(
  provider: ProviderId,
  state: string,
  browserKey: string,
): Promise<{ accountId: string | null; codeVerifier: string } | null> {
  const { data, error } = await supabase
    .from("oauth_states")
    .delete()
    .eq("state", state)
    .eq("provider", provider)
    .eq("browser_key_hash", hashBrowserKey(browserKey))
    .select("*")
    .maybeSingle();
  if (error || !data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  return { accountId: data.account_id, codeVerifier: data.code_verifier };
}

// A field of another type reads as missing, and an answer that is not an
// object as a failed request.
const tokenResponseSchema = z
  .object({
    access_token: z.string().nullish().catch(undefined),
    refresh_token: z.string().nullish().catch(undefined),
    expires_in: z.unknown(),
    scope: z.string().nullish().catch(undefined),
    error: z.string().nullish().catch(undefined),
  })
  .catch({});

async function requestTokens(
  provider: ProviderId,
  params: Record<string, string>,
): Promise<OAuthTokens> {
  const config = getOAuthConfig(provider);
  const body = new URLSearchParams({
    client_id: config.clientId() ?? "",
    ...params,
  });
  const secret = config.clientSecret?.();
  if (secret) body.set("client_secret", secret);

  const response = await providerFetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
    retryOn429: true,
  });
  const answer: unknown = await response.json().catch(() => ({}));
  const json = tokenResponseSchema.parse(answer);
  if (!response.ok || !json.access_token) {
    throw new Error(
      `${provider} token request failed (${response.status}): ${json.error ?? "unknown error"}`,
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt:
      typeof json.expires_in === "number"
        ? new Date(Date.now() + json.expires_in * 1000)
        : null,
    scope: json.scope ?? null,
  };
}

/** Exchange the code with the redirect URI that started the authorization. */
export function exchangeCode(
  provider: ProviderId,
  code: string,
  codeVerifier: string,
  redirect: string,
): Promise<OAuthTokens> {
  return requestTokens(provider, {
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirect,
  });
}

/**
 * Refresh with the redirect URI stored with the Connection: Trakt checks it
 * on refresh too, and a preview or local backend has another origin.
 */
export function refreshTokens(
  provider: ProviderId,
  refreshToken: string,
  redirect: string,
): Promise<OAuthTokens> {
  return requestTokens(provider, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    redirect_uri: redirect,
  });
}
