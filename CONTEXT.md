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
One entry that an Account configures. It points to one or more Source lists and holds how to show them (title, sort, display mode, filters). A Source list is in at most one List of an Account.
_Avoid_: Watchlist, feed, collection

**Merged List**:
A List that points to more than one Source list. Its Catalogs show each Title once, even when several of its Source lists contain it, and they sort by date added only when every Source list gives the date when each Title was added.
_Avoid_: Combined list, aggregate, group

**Catalog**:
One Stremio catalog that a List produces. A List can produce several Catalogs (movies, series, presets).
_Avoid_: Row, shelf

**Refresh**:
One read of a List's Source list on its Provider, which replaces the cached Catalog when it works. A Stremio request for a stale Catalog, a save and the "Refresh now" button start one. When a refresh fails, Stremio keeps the Titles of the last successful refresh, except for a List that lost its Connection. A Catalog preview is not a refresh.
_Avoid_: Sync (alone), fetch, update

**Sync status**:
What the configure page shows for each List: when the last successful refresh happened and how many Titles it gave, or why the latest refresh failed and since when. Each Source list of a Merged List has its own; the List shows the problem of one of them, if any, and else the oldest refresh.
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

### Detection

**Synchronization**:
One read of a Source list by Stremlist. It is complete and successful only when the Provider read did not fail and every page was read. Unresolved entries do not make it incomplete. Only complete, successful ones are compared.
_Avoid_: Sync (in prose), fetch

**Entry key**:
The stable identity of an entry in its Source list, resolved or not: the Provider's own ID for the entry, else its IMDb ID, else its normalized title and year. Synchronizations are compared by entry key.
_Avoid_: Item ID

**Baseline**:
The entries of the first complete, successful Synchronization of a Source list for an Account. They are known, but never new, also when they resolve later.
_Avoid_: Initial import (in code), snapshot

**Detection**:
The moment a complete, successful Synchronization first has an entry that the previous one did not have. Its date is when Stremlist saw the entry, not when the user added it on the Provider, and it stays the same when the entry resolves later. An entry that leaves and comes back keeps its first Detection.
_Avoid_: Addition, added date

**New titles**:
The Catalog of an Account that shows the Titles of its detected entries across all its Lists and every Source list of each, each Title once with its earliest Detection, newest first.
_Avoid_: Recently added, feed
