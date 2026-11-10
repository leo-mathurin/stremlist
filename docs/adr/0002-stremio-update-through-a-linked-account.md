# A linked Stremio account updates the installed addon

Stremio reads an addon's catalogs and resources only at install time. A save that changes them asked the member to reinstall Stremlist: open the Addon URL, Uninstall, open it again, Install. Stremlist now offers a second way, free and optional: link a Stremio account once, and each such save updates the installed Stremlist in the member's Stremio addon collection. The reinstall stays available in every state.

The member links the account with Stremio's own code page, the one Stremio uses to sign in a TV (`link.stremio.com`). The backend asks Stremio for the code and gives the configure page the code page and a token: the code and an expiry, signed with an HMAC bound to the Account. The configure page opens the code page and sends the token to the backend every 2 seconds, in the request body, to ask whether the member confirmed it. Another Account cannot use the token, it expires after 10 minutes, and the code never appears in a Stremlist URL or request log. Once confirmed, the backend reads the Stremio session key, encrypts it with `CONNECTION_ENCRYPTION_KEY` (AES-256-GCM, as for OAuth tokens) and stores it in `stremio_connections`, one row per Account. The configure page only ever sees the account's email.

After a save that changes the manifest, the configure page asks the backend to update Stremio. One update runs at a time per Account: the page waits for its update to end before it sends the next, and the backend takes a lease on the `stremio_connections` row (`claim_stremio_update`), as for OAuth token refreshes. Disconnecting takes the same lease, so a running update cannot write after the member links Stremio again. Inside the lease, the backend reads the Account again, builds its manifest from the database, reads the collection (`api.strem.io`), replaces the manifest of the one entry whose Addon URL matches this Account, writes the collection, and reads it again to check the write. Private Account IDs only: a Legacy alias install keeps the manual reinstall.

## Considered options

- **The key in the member's browser** (`localStorage`), with the browser calling Stremio directly. The first version of this feature did this, so that Stremlist never held the key. Rejected: clearing site data, a private window, or another browser or device lost the link, and each time the member had to link Stremio again. The key on the server also lets the update use the manifest of the last save at the moment it runs, with no request to the Addon URL.
- **Asking for the Stremio password on Stremlist.** Looks like phishing, and accounts created with Facebook or Apple have no password. Rejected.

## Consequences

- Stremlist now holds Stremio sessions that can rewrite a member's addons. The key is encrypted at rest, the table has row level security with no policy for `anon` or `authenticated`, and no route returns it. The Account ID is the only credential for these routes, as for the rest of the configure page.
- The code page hands over the stremio.com session that confirmed the code. Signing out of stremio.com, or changing the Stremio password, ends Stremlist's key: the backend forgets it on Stremio's "Session does not exist" answer, and the page asks to connect again. Disconnecting in Stremlist only forgets the key, because a Stremio logout with it would also sign the member out of stremio.com.
- A Stremio app left open keeps its own copy of the collection and writes all of it back on its next addon change, which can restore the older Stremlist manifest. With a linked account, the configure page asks for an update once per load; the backend writes only when the manifests differ.
- Stremio apps read the collection when they start: the member reloads Stremio Web or restarts the app to see the update.
- A Stremlist removed in Stremio is reported, never added back without the member's request.
- Stremio has no conditional write. If another Stremio app changes the collection between Stremlist's read and write (under 2 s), that change is lost. Stremio's own apps write the collection the same way. The lease prevents this between Stremlist's own updates only.
- Stremio publishes no rate limit for `api.strem.io`, and every call leaves from Vercel's `fra1` addresses. Each update makes 1 to 3 calls, each code confirmation 1. A limit per Account and per address on these routes is a follow-up if Stremio starts to refuse calls.
- A missing or invalid `CONNECTION_ENCRYPTION_KEY` fails the request and keeps the links. Only a key that does not decrypt with the current encryption key is forgotten.
- Deleting the Account deletes the link (`ON DELETE CASCADE`).

## Evidence

A controlled test on the owner's account on 2026-11-10, with a backup and a restore of the collection:

- The code page works for a third party without registration. Signed out of stremio.com, the page asks to sign in (email, Facebook or Apple) and confirms the code on sign-in. Already signed in, opening the link confirms the code at once.
- Two codes confirmed in the same stremio.com session got the same key. Logging that key out signed the browser out of stremio.com.
- A write took 77 to 310 ms. The other 8 addons stayed byte-identical and in the same order; Stremlist kept its position (8 of 9).
- Stremio Web did not show the change in an open tab for 2 minutes. After a reload, it showed it within 7 s, on the board and in its local profile.
- A Stremio Web tab opened before an update wrote its older Stremlist manifest back when the member removed another addon in it.
- An invalid key answers `{"error":{"code":1,"message":"Session does not exist"}}`.
- Safari on the iOS 27.2 simulator (2026-11-10) loaded the code page in the tab that the click opened, with the address set 1.5 s later. The configure page kept asking every 2 to 3 s while it was in the background.
