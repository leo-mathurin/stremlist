import { isProviderId } from "@stremlist/shared/providers";
import { Hono } from "hono";
import { scheduleBackgroundTask } from "../lib/background";
import { frontendUrl } from "../lib/urls";
import { getProvider } from "../providers/registry";
import { saveConnection } from "../services/connections";
import { forgetConnectionDetections } from "../services/detections";
import { rereadConnectionLists } from "../services/lists";
import { consumeState, exchangeCode, redirectUri } from "../services/oauth";

const oauth = new Hono();

/**
 * The redirect URI registered with every Provider app. Exchanges the code
 * (PKCE), stores the encrypted Connection, then sends the user back to the
 * configure page.
 */
oauth.get("/oauth/:provider/callback", async (c) => {
  const provider = c.req.param("provider");
  const { code, state, error } = c.req.query();
  const back = (accountId: string | null, params: Record<string, string>) => {
    const url = new URL("/configure", frontendUrl());
    if (accountId) url.searchParams.set("account", accountId);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return c.redirect(url.toString());
  };

  if (!isProviderId(provider) || !state) {
    return back(null, { connection_error: "invalid_request" });
  }
  const pending = await consumeState(provider, state);
  if (!pending) {
    return back(null, { connection_error: "expired", provider });
  }
  if (error || !code) {
    return back(pending.accountId, {
      connection_error: error === "access_denied" ? "denied" : "failed",
      provider,
    });
  }

  try {
    const redirect = redirectUri(provider, new URL(c.req.url).origin);
    const tokens = await exchangeCode(
      provider,
      code,
      pending.codeVerifier,
      redirect,
    );
    let username: string | null = null;
    try {
      username =
        (await getProvider(provider).oauth?.fetchUsername?.(
          tokens.accessToken,
        )) ?? null;
    } catch (usernameError) {
      console.error(
        `Fetching the ${provider} username failed:`,
        usernameError instanceof Error ? usernameError.message : usernameError,
      );
    }
    await saveConnection(
      pending.accountId,
      provider,
      tokens,
      username,
      redirect,
    );
    // A new Connection can be another Provider user: the history of
    // Connection-only Source lists of the previous user must not stay.
    try {
      await forgetConnectionDetections(pending.accountId, provider);
    } catch (forgetError) {
      console.error(
        `Forgetting the previous ${provider} history failed:`,
        forgetError instanceof Error ? forgetError.message : forgetError,
      );
    }
    // Lists that failed without the Connection (or with the refused one)
    // read through the new one now.
    scheduleBackgroundTask(() =>
      rereadConnectionLists(pending.accountId, provider),
    );
    return back(pending.accountId, { connected: provider });
  } catch (exchangeError) {
    console.error(
      `Completing the ${provider} connection failed:`,
      exchangeError instanceof Error ? exchangeError.message : exchangeError,
    );
    return back(pending.accountId, { connection_error: "failed", provider });
  }
});

export default oauth;
