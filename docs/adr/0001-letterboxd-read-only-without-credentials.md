# Letterboxd is read-only and Stremlist keeps no Letterboxd credentials

Letterboxd has not granted Stremlist access to its official API. Until it does, Stremlist reads only what a member makes readable without signing in: public Source lists, and lists shared through a Share link ("Anyone with share link"). Stremlist does not ask for, store or use a Letterboxd password, session or the credentials of another Letterboxd client. Letterboxd therefore has no Connection and no Actions, and lists visible only to the owner or to friends are out of scope.

## Consequences

- When Letterboxd grants official API access, a Connection and Actions arrive through the same OAuth model as Trakt. This ADR is then superseded.
- Other Letterboxd addons that offer private lists and Actions by signing in for the member are not a precedent for Stremlist.
