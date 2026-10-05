import { createHash } from "node:crypto";
import type { ProviderId } from "@stremlist/shared/providers";
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

export function getOAuthConfig(provider: ProviderId): OAuthConfig {
  const config = getProvider(provider).oauth;
  if (!config?.clientId()) throw new OAuthNotConfiguredError(provider);
  return config;
}

export function isOAuthConfigured(provider: ProviderId): boolean {
  return !!getProvider(provider).oauth?.clientId();
}

/** The callback URL registered with every Provider app. */
export function redirectUri(provider: ProviderId, requestOrigin: string): string {
  const base = (process.env.BACKEND_PUBLIC_URL ?? requestOrigin).replace(/\/+$/, "");
  return `${base}/oauth/${provider}/callback`;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Start an authorization: remember the PKCE verifier under a random state and
 * return the Provider's authorize URL.
 */
export async function startAuthorization(
  accountId: string,
  provider: ProviderId,
  requestOrigin: string,
): Promise<string> {
  const config = getOAuthConfig(provider);
  const state = randomToken();
  const verifier = randomToken(48);

  const { error } = await supabase.from("oauth_states").insert({
    state,
    account_id: accountId,
    provider,
    code_verifier: verifier,
    expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });
  if (error) throw error;

  const url = new URL(config.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId() ?? "");
  url.searchParams.set("redirect_uri", redirectUri(provider, requestOrigin));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (config.scopes?.length) url.searchParams.set("scope", config.scopes.join(" "));
  for (const [key, value] of Object.entries(config.authorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Look up and delete a pending authorization. One use only. */
export async function consumeState(
  provider: ProviderId,
  state: string,
): Promise<{ accountId: string; codeVerifier: string } | null> {
  const { data, error } = await supabase
    .from("oauth_states")
    .delete()
    .eq("state", state)
    .eq("provider", provider)
    .select("*")
    .maybeSingle();
  if (error || !data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  return { accountId: data.account_id, codeVerifier: data.code_verifier };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

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
      ...config.tokenHeaders?.(),
    },
    body: body.toString(),
    retryOn429: true,
  });
  const json = (await response.json().catch(() => ({}))) as TokenResponse;
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

export function exchangeCode(
  provider: ProviderId,
  code: string,
  codeVerifier: string,
  requestOrigin: string,
): Promise<OAuthTokens> {
  return requestTokens(provider, {
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri(provider, requestOrigin),
  });
}

export function refreshTokens(
  provider: ProviderId,
  refreshToken: string,
): Promise<OAuthTokens> {
  return requestTokens(provider, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    // Trakt checks the redirect URI on refresh too.
    redirect_uri: redirectUri(provider, "https://api.stremlist.com"),
  });
}
