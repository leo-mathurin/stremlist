import { isProviderId } from "@stremlist/shared/providers";
import { Hono } from "hono";
import { frontendUrl } from "../lib/urls";

const oauth = new Hono();

oauth.get("/oauth/:provider/callback", (c) => {
  const provider = c.req.param("provider");
  const { code, state, error } = c.req.query();
  const url = new URL("/configure", frontendUrl());
  if (!isProviderId(provider) || !state) {
    url.searchParams.set("connection_error", "invalid_request");
    return c.redirect(url.toString());
  }
  const answer = new URLSearchParams({ oauth: provider, state });
  if (code && !error) answer.set("code", code);
  else
    answer.set("oauth_error", error === "access_denied" ? "denied" : "failed");
  url.hash = answer.toString();
  return c.redirect(url.toString());
});

export default oauth;
