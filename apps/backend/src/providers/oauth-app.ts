import type { RateLimiter } from "./http";
import { ensureOk, providerFetch } from "./http";

/** An environment value; blank counts as unset. */
function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  return value;
}

export interface OAuthClient {
  /** Undefined when the Provider app is not configured. */
  clientId: () => string | undefined;
  clientSecret: () => string | undefined;
}

/** A Provider app's credentials, read from `{PREFIX}_CLIENT_ID` and `{PREFIX}_CLIENT_SECRET`. */
export function oauthClient(prefix: string): OAuthClient {
  return {
    clientId: () => envValue(`${prefix}_CLIENT_ID`),
    clientSecret: () => envValue(`${prefix}_CLIENT_SECRET`),
  };
}

/**
 * Revoke a token (RFC 7009) with a form body. The secret goes in only when
 * the app has one. Throws HttpError when the Provider refuses.
 */
export async function revokeToken(
  url: string,
  token: string,
  client: OAuthClient,
  limiter?: RateLimiter,
): Promise<void> {
  const body = new URLSearchParams({
    token,
    client_id: client.clientId() ?? "",
  });
  const secret = client.clientSecret();
  if (secret) body.set("client_secret", secret);
  const response = await providerFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
    limiter,
    retryOn429: false,
  });
  await ensureOk(response, url);
}
