# Actions open a Stremlist page, they never play a clip

Stremio addons cannot add buttons, so Actions (add to watchlist, mark as watched, rate) are entries in the stream list. Existing action addons (for example ericvlog's Trakt and Overseerr addons) use a stream `url` that performs the Action and then redirects to a short video clip. We read the current stremio-core and stremio-web code (2026-10-06): playing that clip goes through the normal player path. It creates or updates the title's library item, flags the title as watched once the clip passes 70% of its duration, sends progress events (towards Stremio's Trakt sync and any scrobbler addon), can put the title in Continue Watching, and stores the Action as the "last used stream", so "Resume" runs the Action again. No stream hint turns this off.

So every Action entry uses `externalUrl` to a small Stremlist page that performs the Action and shows the result. The player never loads, so there is no side effect on the library or on Trakt. Each URL states one explicit intent (`add`, `remove`, `watched`, `unwatched`, `rate`), so opening it twice gives the same result. Stream responses use `cacheMaxAge: 0` and no `bingeGroup`.

## Consequences

- The user leaves Stremio for a moment (a browser tab), and the entry labels stay old until the title page is opened again.
- On LG and Samsung TVs, Stremio does not open external URLs (endless spinner), so Actions are not available there. The configure page says so.
- Stremio orders streams by the user's addon order, and a new addon is installed last. Actions are off by default; the configure page explains how to move Stremlist just after Cinemeta (which returns no streams) so the Actions show at the top.
