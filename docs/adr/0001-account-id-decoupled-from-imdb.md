# Accounts use a generated secret ID, not the IMDb user ID

Stremlist used the IMDb user ID (`ur…`) as the account key and in the Addon URL. Other Providers (Trakt, Letterboxd, …) have no `ur` ID, and OAuth tokens make the open config endpoint a route to private data. We now give each Account a random ID that cannot be guessed, and the Addon URL that contains it is the only credential: whoever has the URL can read and change the Account. This is the usual model for Stremio addons and needs no login system.

Existing installs keep working: their `ur…` ID stays as a Legacy alias, because a Stremio install URL cannot be changed from the server. A Legacy alias can be guessed, so it is not a secret. To connect a Provider through OAuth, the user upgrades: Stremlist copies the Lists into a new Account with a private Addon URL (one reinstall). The legacy install keeps serving its public Lists, so nothing breaks until the user removes it. After the copy, its configure page no longer saves changes and sends the user to the new install; it never shows the new Addon URL, because anyone can open a Legacy alias. A user who lost the new URL can make another copy.

## Considered Options

- Keep `ur…` as the key and require an IMDb account for everyone: blocks users of other Providers.
- Use a Provider identity as the key (`trakt:name`): guessable, and ties the Account to one Provider.
- Real login (magic link or OAuth) on the configure page: more secure, but a large new surface for a product where the Addon URL is already shared with Stremio.
