import type { ProviderId } from "@stremlist/shared/providers";
import { PROVIDERS, isProviderId } from "@stremlist/shared/providers";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Child } from "hono/jsx";
import { getProvider } from "../providers/registry";
import type { ActionIntent } from "../providers/types";
import type { Account } from "../services/accounts";
import { resolveAccountKey } from "../services/accounts";
import type { ActionOutcome } from "../services/actions";
import {
  actionProviders,
  currentRatings,
  parseStreamId,
  performAction,
} from "../services/actions";

const actions = new Hono();

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #f0f0f0; color: #141414; padding: 24px;
    font-family: ui-rounded, "SF Pro Rounded", system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 420px; background: #fff; border-radius: 20px;
    padding: 28px; box-shadow: 0 10px 30px rgb(0 0 0 / 0.08); }
  header { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; font-weight: 700; }
  header img { width: 32px; height: 32px; border-radius: 8px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { margin: 0 0 12px; line-height: 1.5; color: #444; }
  .ok { color: #1a7f37; } .err { color: #b42318; }
  ul { padding-left: 18px; margin: 0 0 12px; color: #444; }
  form { display: grid; gap: 16px; }
  .stars { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
  .stars label { display: block; }
  .stars input { position: absolute; opacity: 0; }
  .stars span { display: grid; place-items: center; height: 44px; border-radius: 12px;
    border: 2px solid #e5e5e5; font-weight: 700; cursor: pointer; }
  .stars input:checked + span { background: #f5c518; border-color: #f5c518; }
  .stars input:focus-visible + span { outline: 2px solid #141414; outline-offset: 2px; }
  fieldset { border: 0; padding: 0; margin: 0; display: grid; gap: 8px; }
  legend { font-weight: 600; margin-bottom: 8px; }
  .provider { display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 10px 12px; border: 1px solid #e5e5e5; border-radius: 12px; }
  .provider small { color: #666; }
  .buttons { display: flex; gap: 8px; flex-wrap: wrap; }
  button { appearance: none; border: 0; border-radius: 12px; padding: 12px 16px; font: inherit;
    font-weight: 700; cursor: pointer; }
  .primary { background: #f5c518; color: #141414; flex: 1; }
  .secondary { background: #f0f0f0; color: #141414; }
  .hint { font-size: 13px; color: #666; margin-top: 16px; }
`;

function Page({ title, children }: { title: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>{`${title} · Stremlist`}</title>
        <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      </head>
      <body>
        <main>
          <header>
            <img src="https://stremlist.com/icon.png" alt="" />
            Stremlist
          </header>
          {children}
        </main>
      </body>
    </html>
  );
}

function names(providers: ProviderId[]): string {
  return providers.map((p) => PROVIDERS[p].label).join(", ");
}

function OutcomePage({
  done,
  outcomes,
}: {
  done: (providers: string) => string;
  outcomes: ActionOutcome[];
}) {
  const ok = outcomes.filter((o) => o.ok).map((o) => o.provider);
  const failed = outcomes.filter((o) => !o.ok).map((o) => o.provider);
  const title = ok.length > 0 ? "Done" : "Something went wrong";
  return (
    <Page title={title}>
      {ok.length > 0 && <h1 class="ok">✓ {done(names(ok))}</h1>}
      {failed.length > 0 && (
        <p class="err">
          It did not work on {names(failed)}. Try again later, or connect the
          account again on the Stremlist configure page.
        </p>
      )}
      <p class="hint">You can close this tab and go back to Stremio.</p>
    </Page>
  );
}

async function privateAccount(c: Context): Promise<Account | null> {
  const access = await resolveAccountKey(c.req.param("accountId"));
  return access?.via === "private" ? access.account : null;
}

function notFound(c: Context) {
  return c.html(
    <Page title="Not found">
      <h1>This link does not work</h1>
      <p>Open the title in Stremio again and select the action there.</p>
    </Page>,
    404,
  );
}

function supporting(providers: ProviderId[], kind: ActionIntent["kind"]) {
  return providers.filter((provider) =>
    getProvider(provider).actions?.kinds.includes(kind),
  );
}

// Watchlist and watched: one explicit intent per URL, so opening it twice
// gives the same result (ADR 0003).
actions.get("/:accountId/actions/:kind/:op/:type/:id", async (c) => {
  const { kind, op, type } = c.req.param();
  if (kind === "rating") return renderRating(c);
  if (
    (kind !== "watchlist" && kind !== "watched") ||
    (op !== "add" && op !== "remove") ||
    (type !== "movie" && type !== "series")
  ) {
    return notFound(c);
  }
  const target = parseStreamId(type, decodeURIComponent(c.req.param("id")));
  const account = await privateAccount(c);
  if (!target || !account) return notFound(c);

  const providers = supporting(await actionProviders(account), kind);
  const add = op === "add";
  // Watchlist Actions apply to the whole series, not to one episode.
  const effective =
    kind === "watchlist"
      ? { imdbId: target.imdbId, type: target.type }
      : target;
  const outcomes = await performAction(
    account,
    providers,
    { kind, add },
    effective,
  );

  const episode = target.episode
    ? `S${String(target.episode.season).padStart(2, "0")}E${String(target.episode.episode).padStart(2, "0")} `
    : "";
  const done = (list: string) =>
    kind === "watchlist"
      ? add
        ? `Added to your watchlist on ${list}`
        : `Removed from your watchlist on ${list}`
      : add
        ? `${episode}marked as watched on ${list}`
        : `${episode}marked as unwatched on ${list}`;
  return c.html(<OutcomePage done={done} outcomes={outcomes} />);
});

async function renderRating(c: Context) {
  const type = c.req.param("type");
  if (type !== "movie" && type !== "series") return notFound(c);
  const target = parseStreamId(type, decodeURIComponent(c.req.param("id")));
  const account = await privateAccount(c);
  if (!target || !account) return notFound(c);

  const ratings = await currentRatings(account, target.imdbId);
  if (ratings.length === 0) return notFound(c);
  const current = ratings.find((r) => r.rating !== null)?.rating ?? null;

  return c.html(
    <Page title="Rate">
      <h1>Rate this {type === "series" ? "series" : "movie"}</h1>
      <form method="post">
        <div class="stars" role="radiogroup" aria-label="Rating from 1 to 10">
          {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => (
            <label>
              <input
                type="radio"
                name="rating"
                value={String(value)}
                checked={current === value}
                required
              />
              <span>{value}</span>
            </label>
          ))}
        </div>
        <fieldset>
          <legend>Send the rating to</legend>
          {ratings.map(({ provider, rating }) => (
            <label class="provider">
              <span>
                <input
                  type="checkbox"
                  name="providers"
                  value={provider}
                  checked
                />{" "}
                {PROVIDERS[provider].label}
              </span>
              <small>
                {rating === null ? "Not rated" : `Now ${rating}/10`}
              </small>
            </label>
          ))}
        </fieldset>
        <div class="buttons">
          <button class="primary" type="submit">
            Save rating
          </button>
          {current !== null && (
            <button
              class="secondary"
              type="submit"
              name="remove"
              value="1"
              formnovalidate
            >
              Remove rating
            </button>
          )}
        </div>
      </form>
    </Page>,
  );
}

actions.post("/:accountId/actions/rating/rate/:type/:id", async (c) => {
  const type = c.req.param("type");
  if (type !== "movie" && type !== "series") return notFound(c);
  const target = parseStreamId(type, decodeURIComponent(c.req.param("id")));
  const account = await privateAccount(c);
  if (!target || !account) return notFound(c);

  const form = await c.req.parseBody({ all: true });
  const remove = form.remove === "1";
  const rating = Number(form.rating);
  if (!remove && !(Number.isInteger(rating) && rating >= 1 && rating <= 10)) {
    return renderRating(c);
  }
  const submitted: unknown = form.providers;
  const chosen = (Array.isArray(submitted) ? submitted : [submitted]).filter(
    (value): value is ProviderId =>
      typeof value === "string" && isProviderId(value),
  );
  const providers = supporting(await actionProviders(account), "rating").filter(
    (provider) => chosen.includes(provider),
  );

  const outcomes = await performAction(
    account,
    providers,
    { kind: "rating", rating: remove ? null : rating },
    { imdbId: target.imdbId, type: target.type },
  );
  const done = (list: string) =>
    remove ? `Rating removed on ${list}` : `Rated ${rating}/10 on ${list}`;
  return c.html(<OutcomePage done={done} outcomes={outcomes} />);
});

export default actions;
