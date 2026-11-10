# A linked Stremio account updates the installed addon from the browser

Stremio reads an addon's catalogs and resources only at install time. A save that changes them asked the member to reinstall Stremlist: open the Addon URL, Uninstall, open it again, Install. Stremlist now offers a second way, free and optional: link a Stremio account once, and each such save updates the installed Stremlist in the member's Stremio addon collection. The reinstall stays available in every state.

The member links the account with Stremio's own code page, the one Stremio uses to sign in a TV (`link.stremio.com`). The code page answers with a Stremio session key. The key stays in the member's browser (`localStorage`); Stremlist's servers never receive it. The browser calls Stremio's API directly (`api.strem.io`, CORS `*`), reads the collection, replaces the manifest of the one entry whose Addon URL matches this Account, writes the collection, and reads it again to check the write.

## Considered options

- **The key on the server, encrypted at rest** (STR-70/STR-71 for Stremlist Plus). Needed for updates without the member present, such as watched-state sync. It makes Stremlist hold full-account Stremio sessions for every free member, for an action that only happens on the configure page. Rejected for the free update; it stays the design if a background job ever needs the key.
- **Asking for the Stremio password on Stremlist.** Looks like phishing, and accounts created with Facebook or Apple have no password. Rejected.

## Consequences

- The code page hands over the stremio.com session that confirmed the code. Signing out of stremio.com, or changing the Stremio password, ends Stremlist's key: the page asks to connect again. Disconnecting in Stremlist only forgets the key, because a Stremio logout with it would also sign the member out of stremio.com.
- A Stremio app left open keeps its own copy of the collection and writes all of it back on its next addon change, which can restore the older Stremlist manifest. With a linked account, the configure page checks the installed manifest once per load and writes the current one when they differ.
- Stremio apps read the collection when they start: the member reloads Stremio Web or restarts the app to see the update.
- A Stremlist removed in Stremio is reported, never added back without the member's request.
- The key lives in `localStorage`, so a script injected into the Stremlist origin could read it. The site has no third-party scripts besides Vercel Web Analytics.

## Evidence

A controlled test on the owner's account on 2026-11-10, with a backup and a restore of the collection:

- The code page works for a third party without registration. Signed out of stremio.com, the page asks to sign in (email, Facebook or Apple) and confirms the code on sign-in. Already signed in, opening the link confirms the code at once.
- Two codes confirmed in the same stremio.com session got the same key. Logging that key out signed the browser out of stremio.com.
- A write took 77 to 310 ms. The other 8 addons stayed byte-identical and in the same order; Stremlist kept its position (8 of 9).
- Stremio Web did not show the change in an open tab for 2 minutes. After a reload, it showed it within 7 s, on the board and in its local profile.
- A Stremio Web tab opened before an update wrote its older Stremlist manifest back when the member removed another addon in it.
- An invalid key answers `{"error":{"code":1,"message":"Session does not exist"}}`.
