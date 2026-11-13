# Investigation Letterboxd avec REA

Date : 25 octobre 2026. Objectif : comparer le site, le code Android et
l'application sur le téléphone de Léo pour évaluer une intégration Stremlist.
Le compte Letterboxd et le téléphone sont autorisés pour cette investigation.

## État de couverture

- Site public : analyse réalisée, rapport séparé
  [letterboxd-web-2026-10-25.md](letterboxd-web-2026-10-25.md).
- Site authentifié : aucune connexion importée le 25 octobre ; connexion et
  lecture de listes privées validées dans le complément du 26 octobre.
- APK : copie installée récupérée, vérifiée et analysée dans
  [le rapport Android statique](letterboxd-android-static-2026-10-25.md).
- Application physique : compte connecté, lecture de watchlist et observation
  réseau réalisées ; voir [le rapport runtime](letterboxd-android-runtime-2026-10-25.md).
- Aucune capacité non vérifiée ne constitue un résultat positif.

## Complément du 26 octobre : listes privées

À la demande explicite de l'utilisateur, deux listes ont été créées avec la
visibilité **You (private list)**, une avec deux films et une vide. Le
navigateur connecté et l'application Android les lisent. Les mêmes pages
répondent HTTP 404 sans session et n'apparaissent pas dans l'annuaire public.
La lecture privée par HTML avec une session utilisateur est donc démontrée
sur ces cas. Voir [le rapport et les preuves](letterboxd-private-lists-2026-10-26.md).

Ce complément corrige également une erreur de nettoyage du relais : la clé
historique `http_proxy=null` ne suffisait pas à prouver le retrait du proxy
effectif. Les clés effectives ont été remises à un hôte vide et au port `0`,
et la recherche puis le chargement des nouvelles listes sur le téléphone ont
été vérifiés.

## Résultats corroborés

La watchlist publique de Léo expose les mêmes quatre films que l'application
Android connectée. Au début de l'investigation, le compte n'avait aucune liste
existante ; les cas privés ont ensuite été créés et testés le 26 octobre.

Un contrôle supplémentaire utilise le `fetch` de Bun 1.4.3, avec ses en-têtes
par défaut, sans fournir de cookie ou de session. La requête vers
`https://letterboxd.com/lelemathrin/watchlist/` répond HTTP 200 et contient
quatre cartes `LazyPoster`, sans marqueur de challenge reconnu. Le corps fait
103 072 octets et son SHA-256 est
`45468e58393a7868fd2ed13dd0468ff30407f69b956ed512232d0f22c074e9f3`.
Les fichiers privés `own-watchlist-bun.json` et `own-watchlist-bun.html`
conservent cette observation Bun ; ce ne sont pas des preuves REA.
Ce test établit l'accès depuis la tour à cet instant, pas depuis les Workers
Cloudflare, ni sous une charge ou une cadence de production.

Le téléphone contacte `api.letterboxd.com:443` pendant un redémarrage et un
rafraîchissement. Le relais utilisé conserve uniquement les métadonnées de
connexion, sans déchiffrer le TLS. Les routes complètes, l'authentification et
les modèles récupérés du code sont des preuves statiques distinctes.

La redirection ADB temporaire est retirée. Le proxy effectif est corrigé et
revérifié le 26 octobre. La première phase n'a changé ni collections ni notes ;
le complément crée uniquement les deux listes privées demandées, sans modifier
la watchlist ou les notes de films.

## Conséquences pour Stremlist

**Lecture publique.** Une V1 en lecture seule dispose d'une piste démontrée :
le HTML contient les collections, leur ordre et les identifiants Letterboxd.
La correspondance IMDb/TMDB peut être obtenue sur une fiche de film, avec une
table commune pour éviter de refaire ce travail pour chaque utilisateur.
La taille de page varie selon les collections observées. Il reste à vérifier
le mode d'accès depuis l'hébergement réel, les échecs, la fraîcheur et le
volume soutenable avant de promettre un service pour 10 000 à 50 000 comptes.

**Accès API authentifié.** Le code Android contient des routes JSON avec
curseurs pour les listes et les watchlists. Il utilise les identifiants OAuth
du client officiel, un flux Password et une reprise par refresh token. Cette
analyse explique le protocole ; elle n'attribue pas une identité OAuth à
Stremlist. Le chemin documenté pour un client tiers authentifié est
Authorization Code. Aucun identifiant ou secret embarqué n'est reproduit ou
réutilisé pour émettre une requête API dans cette investigation.

Le modèle `FilmSummary` peut porter des liens typés IMDb/TMDB. Leur présence
effective dans les réponses, et les champs accordés à un client tiers,
restent inconnus. Il ne faut ni imposer une requête par film sur la seule base
du HTML, ni promettre que l'API remplit toujours ces correspondances.

**Contenu privé et écriture.** Le complément du 26 octobre valide la création
des listes privées et leur lecture avec une session web du propriétaire et
dans l'application. La liste vide autorisée répond HTTP 200 ; un accès anonyme
refusé à la même URL répond HTTP 404. Le TLS natif relayé ne révèle pas les
réponses ni les jetons. Les droits OAuth d'un client Stremlist, les quotas,
renouvellements effectifs et révocations nécessitent une validation distincte.

## Préparation et preuves locales

L'hôte d'exécution est la tour Ubuntu. `rea list-adb-devices --format json
--full-output` n'y détecte aucun appareil. L'utilisateur a confirmé que le
téléphone est branché au Mac. Evidence REA :
`ev_d01dc0515972034f0c6c250d6ef01299af369ba2a3fde9b25f4a83bcd63e23bc`.

Un Grant Mac Access de deux heures a été demandé puis approuvé par
l'utilisateur. Il a permis la découverte du téléphone sur le Mac et la
récupération de la version installée depuis Google Play, 3.6.4, code 510.
Le SHA-256 de l'APK principal est
`7cc023baebc4a22582ff7720907d20790919f6897cc65522a4e8e0a7c594b89b`.

REA 6.7.0 est disponible. Le moteur JADX headless MCP 0.7.1 a été téléchargé
depuis sa release et son SHA-256 vérifié contre la valeur publiée par REA :
`6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75`.
Un JDK 17 complet est présent. Les conclusions de décompilation sont conservées
séparément dans le rapport statique, avec leurs preuves REA.

Les preuves et métadonnées locales sont dans
`~/.local/share/rea/investigations/letterboxd-20261025/`, hors du dépôt.
L'analyse n'exige aucun changement des listes ou des notes du compte.

## Références officielles à comparer avec l'application

La [documentation de l'API Letterboxd](https://api-docs.letterboxd.com/)
décrit une API JSON sous `https://api.letterboxd.com/api/v0/`, avec des
identifiants Letterboxd et des routes pour watchlist et listes. Elle distingue
OAuth Authorization Code pour l'accès tiers authentifié du flux Password,
réservé aux clients de Letterboxd. Elle précise que certaines capacités sont
réservées aux clients « First Party » et que la signature historique des
requêtes n'est plus requise. Ces déclarations documentaires ne prouvent pas
encore le comportement de la version Android installée.

La [page d'accès à l'API](https://letterboxd.com/api-beta/) demande toujours
une candidature. Comprendre l'application ne constitue donc pas une attribution
de client API à Stremlist.

La [page officielle des applications](https://letterboxd.com/apps/) pointe
vers le [paquet Google Play](https://play.google.com/store/apps/details?id=com.letterboxd.letterboxd)
`com.letterboxd.letterboxd`. L'identité de la copie installée et ses empreintes
restent à relever sur le téléphone.

## Limites et suite nécessaire

La requête HTTP ordinaire vers `/.well-known/assetlinks.json` a renvoyé 403.
Une tentative de métadonnées du distributeur Aptoide a également renvoyé 403.
Aucun APK n'a été obtenu par ces voies et aucune identité de signature n'en
est déduite. Aucun contournement n'a été tenté.

L'inventaire, la récupération des APK, l'analyse statique et l'observation de
l'application sont réalisés. Le code et le serveur contacté concordent sur
l'usage de l'API Letterboxd. Les limites qui restent ouvertes concernent le
contenu des réponses API natives chiffrées et les droits d'un client
tiers et les quotas. Aucune capacité pour des dizaines de milliers
d'utilisateurs n'a été mesurée.
