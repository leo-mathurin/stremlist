# Stremlist

Stremlist turns lists of titles kept on external services into catalogs inside Stremio. A user configures which lists to show; Stremio reads them through the user's addon install.

## Language

### Accounts

**Account**:
One Stremlist user, identified by an Account ID that Stremlist generates and that no external service controls.
_Avoid_: User (ambiguous with provider users), IMDb user

**Addon URL**:
The Stremio install URL of an Account. It contains the Account ID and acts as the Account's secret: whoever has it can read and change the Account.
_Avoid_: Manifest URL, install link

**Legacy alias**:
An IMDb user ID (`ur…`) that still resolves to an Account because Stremio installs made before Accounts existed use it in their Addon URL.
_Avoid_: Old user ID

### Lists

**Provider**:
An external service that keeps lists of titles, such as IMDb, Trakt, Simkl, JustWatch, Letterboxd or SensCritique.
_Avoid_: Source, platform, service

**Source list**:
One collection of titles on a Provider, identified by the Provider and a reference that the Provider understands (a watchlist, a custom list, a chart).
_Avoid_: Remote list, feed

**Watchlist**:
The kind of Source list that a Provider keeps as a user's default "to watch" list. Only this kind is called a watchlist.
_Avoid_: Using "watchlist" for any configured List

**List**:
One entry that an Account configures. It points to exactly one Source list and holds how to show it (title, sort, display mode, filters).
_Avoid_: Watchlist, feed, collection

**Catalog**:
One Stremio catalog that a List produces. A List can produce several Catalogs (movies, series, presets).
_Avoid_: Row, shelf

**Refresh**:
One read of a List's Source list on its Provider, which replaces the cached Catalog when it works. A Stremio request for a stale Catalog, a save and the "Refresh now" button start one. When a refresh fails, Stremio keeps the Titles of the last successful refresh, except for a List that lost its Connection.
_Avoid_: Sync (alone), fetch, update

**Sync status**:
What the configure page shows for each List: when the last successful refresh happened and how many Titles it gave, or why the latest refresh failed and since when.
_Avoid_: Health, state

**Catalog preview**:
What a List will show in Stremio, on the configure page before the user saves: the first Titles of each of its Catalogs, and its Unresolved entries. It does not change any Catalog.
_Avoid_: Sample, dry run

### Titles

**Title**:
A movie or a series, always identified by its IMDb ID (`tt…`). Everything that Stremlist shows or acts on is a Title.
_Avoid_: Item, media, product, film (for both kinds)

**Unresolved entry**:
An entry of a Source list for which no IMDb ID is known yet. It is not shown, and Stremlist tries again to resolve it on later refreshes.
_Avoid_: Missing item, dropped item

### Provider access

**Connection**:
The authorization that links one Account to its user on one Provider, so Stremlist can read private Source lists and perform Actions. An Account has at most one Connection per Provider.
A Connection needs renewal when its Provider refuses it (revoked access, refused token refresh). The user renews it by connecting the Provider again.
_Avoid_: Integration, link, login

**Action**:
A change that a user asks Stremlist to make on a Provider from inside Stremio, such as add to watchlist, remove from watchlist, mark as watched, or rate. Only a Provider with a Connection supports Actions.
_Avoid_: Write, sync-back
