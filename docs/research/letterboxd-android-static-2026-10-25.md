# Letterboxd Android 3.6.4 : analyse statique pour Stremlist

Date : 25 octobre 2026. Périmètre : le code et les ressources du seul
`base.apk` fourni par le parent. Cette analyse ne lance pas l'application,
ne contrôle ni le téléphone ni le navigateur et n'appelle aucun endpoint
métier Letterboxd. La documentation publique est consultée séparément.

## Résultats utiles à la décision

Le client Android contient des API structurées pour énumérer les listes,
lire leurs entrées et lire une watchlist. Il prévoit une pagination par
curseur. Les entrées portent des objets `FilmSummary` avec un tableau de
liens externes. Une requête de détail par film ne doit donc pas être supposée
nécessaire avant d'avoir observé les réponses réelles.

L'application officielle embarque ses propres identifiants OAuth. Leur
présence est un constat sur ce binaire, sans garantie d'accès pour Stremlist.
Le chemin de connexion observé emploie le flux Password du client officiel.
La voie documentée pour authentifier les utilisateurs d'un client tiers est
Authorization Code. Aucun identifiant client, secret, jeton ou mot de passe
n'est reproduit dans ce rapport.

Pour une intégration de dizaines de milliers d'utilisateurs, les principales
inconnues restent les droits du client tiers, ses quotas et le contenu réel
des réponses, surtout les liens IMDb/TMDB. Une application qui sait lire ses
propres données ne démontre ni les droits ni la capacité d'un autre client.

## Identité et méthode

| Élément | Valeur et origine |
| --- | --- |
| Fichier | `/home/leo/.local/share/rea/investigations/letterboxd-20261025/apks/base.apk` |
| Taille | 154 190 863 octets, vérifiée localement |
| SHA-256 | `7cc023baebc4a22582ff7720907d20790919f6897cc65522a4e8e0a7c594b89b` |
| Package | `com.letterboxd.letterboxd`, manifeste décodé par REA [E01] |
| Version | `3.6.4`, code `510` [E01] |
| Android | `minSdkVersion=29`, `targetSdkVersion=36` [E01] |
| Installateur | `com.android.vending`, renseigné par le parent depuis le téléphone, non établi par l'APK seul |
| REA | CLI `6.7.0`, sorties JSON avec enveloppe complète |
| Moteur | JADX headless MCP `0.7.1`, utilisé par le CLI, un worker par analyse [E01] |
| JAR moteur SHA-256 | `6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75` [E01] |
| Java | JDK 17 complet, `/usr/lib/jvm/java-17-openjdk-amd64` |

`JAVA_HOME` et `REA_JADX_MCP_JAR` sont limités à l'environnement des
commandes. Aucun réglage MCP ou global n'a été modifié. Aucun commit n'est
créé. Le hash du fichier établit l'identité de cette copie ; il ne constitue
pas une vérification de son certificat de signature APK.

La première opération est `inspect-android-package`, puis
`search-android-classes` avec une requête vide. L'inventaire REA contient
54 777 noms de classes, avec une couverture déclarée complète pour cet
inventaire [E02]. Les candidats réseau, OAuth, listes et watchlist sont
ensuite sélectionnés par leur nom ; leurs membres sont inventoriés avant
les inspections ciblées. Les références statiques entrantes sont examinées
pour le client OAuth et `okhttp3.CertificatePinner`.

Les JSON complets et les erreurs sont conservés dans le répertoire privé
`/home/leo/.local/share/rea/investigations/letterboxd-20261025/static/`, hors
du dépôt. Ce dossier contient aussi les sélecteurs des appels dans
`batch*.json` et un index de provenance. Un lecteur local masque les
littéraux dans les vues de travail. Les preuves brutes peuvent
contenir des identifiants embarqués et ne doivent pas être publiées.

Dans la suite, **observé** désigne une déclaration, une instruction ou un
modèle récupéré dans cet APK. **Déduction** désigne une conséquence proposée
pour l'intégration. **Inconnu** désigne ce qui exige une réponse serveur, une
observation sur le téléphone ou un accord d'accès au client tiers.

## Framework et construction des requêtes

**Observé.** Les classes d'interface comprennent Jetpack Compose et Android.
Le gestionnaire `com.letterboxd.letterboxd.api.LetterboxdAPIManager` construit
les objets `ListsApi`, `MembersApi`, `FilmsApi` et d'autres API autour d'une
`com.letterboxd.api.support.Configuration`. Cette dernière utilise Ktor avec
le moteur OkHttp et la négociation de contenu JSON ; les modèles possèdent
des sérialiseurs `kotlinx.serialization` [E02, E13, E49, E51].

Le constructeur du gestionnaire choisit, selon un booléen, entre
`https://api.letterboxd.com/api/v0` et
`https://st.letterboxd.com/api/v0`. La configuration normalise le slash
final avant de joindre les chemins relatifs [E13, E49]. La présence de ce
choix n'établit pas la branche prise sur le téléphone.

Le gestionnaire installe `UserAgent`, `HttpRequestRetry` et un en-tête
`Accept-Language` [E14, E46, E47]. Le retry utilise un délai exponentiel et
une liste de statuts transitoires, dont une constante nommée
`CODE_TOO_MANY_REQUESTS` [E47, E48]. Ce code ne révèle aucun quota accordé
à Stremlist, débit soutenable ou garantie de délai serveur.

## Authentification, renouvellement et signature

**Observé.** `LetterboxdAPIManager.<init>(AccessTokenDataManager, boolean)`
charge un identifiant client depuis `BuildConfig.API_KEY` et décode un
secret embarqué. Seuls leur rôle et leur présence sont retenus [E13].
`buildPasswordFlowClient` et `buildCredentialsFlowClient` construisent deux
clients distincts [E15, E16]. Le helper Password de `SecuritySchemeKt`
fixe les URL d'émission et de renouvellement à
`https://api.letterboxd.com/api/v0/auth/token` [E76].

`OAuthPasswordFlowClient.authenticate_yxL6bBk$lambda$0$0` remplit les
paramètres `grant_type=password`, `username`, `password`, `client_id`,
`client_secret`, puis les scopes et des paramètres additionnels éventuels
[E43]. `LetterboxdAPIManager.m10184authenticateBWLJW6A` appelle ce client
et le place dans le contrôleur pour `SecurityScheme.OAUTH` après le résultat
d'authentification [E44]. La présence de
`OAuthAuthorizationCodeFlowClient` dans la bibliothèque ne démontre pas
que l'écran de connexion Android utilise ce flux [E02].

`AccessTokenDataManager` déclare un DataStore de préférences et des clés
pour access token, refresh token, type, date de création et expiration [E04].
Cette déclaration ne prouve ni le contenu actuellement stocké ni son
chiffrement. La méthode de reprise de session
`m10185signInWithTokenIoAF18A` lit le refresh token conservé, prévoit une
ancienne clé de stockage en secours et construit un client Password pour
reprendre la session [E45]. Le contrôle de flux décompilé de cette méthode
comporte des avertissements JADX ; ses branches d'erreur exactes restent
à confirmer.

`OAuthAccessTokenManager.m10151authorizegIAlus` vérifie l'expiration du
jeton avant de poser l'en-tête `Authorization` [E56].
`authorizationHeader(String)` construit précisément `Bearer ` suivi du
jeton [E72]. `m10152refreshTokenIoAF18A` récupère l'URL de renouvellement et
le jeton courant, puis lance une coroutine dédiée sous coordination par
mutex [E74]. Cette coroutine lit le refresh token, soumet des paramètres
avec `FormBuildersKt.submitForm`, décode un `OAuthAccessToken` sur réponse
OK et met à jour sa date de création ainsi que le jeton conservé [E83].
La lambda de formulaire remplit `grant_type` avec la constante de refresh
token, puis le refresh token, `client_id` et `client_secret` [E86].
Le chemin de réauthentification compare
l'en-tête de la requête échouée au jeton courant et comporte un mutex [E57].
Les méthodes HTTP examinées contiennent aussi un traitement de réponse
`Unauthorized` et une option `allowsReauth` [E53, E54, E55]. Il s'agit de
mécanismes présents dans le code, sans réponse 401 observée ici.

Un timer de renouvellement anticipé existe [E64], mais le helper appelé
par défaut par le gestionnaire fournit `duration=null` [E15, E77]. Il ne
faut donc pas déclarer qu'un rafraîchissement périodique anticipé est actif.
La durée réelle des jetons, la rotation des refresh tokens et les causes
de déconnexion restent inconnues dans cette tâche.

**Signature.** Le chemin examiné va du constructeur API à Ktor/OkHttp,
puis au contrôleur OAuth et à l'ajout de l'en-tête d'autorisation.
Le constructeur synthétique de `Configuration` laisse le callback
`finalizeRequestBlock` à `null` pour le masque passé par le gestionnaire
[E13, E84]. Les constructeurs de paramètres de listes et watchlist ne montrent pas
d'ajout de `signature`, `nonce` ou `timestamp` [E49, E51, E56, E69, E70,
E71]. Aucun calcul de signature supplémentaire n'est observé sur ces
chemins. Ce résultat borné n'est pas une preuve d'absence dans tout le
binaire ou dans des modules chargés dynamiquement.

## Routes, pagination et modèles

**Observé.** Les chemins relatifs et les méthodes sont construits dans les
coroutines ci-dessous, puis joints à la base URL par `Configuration`.

| Usage | Construction observée | Paramètres utiles |
| --- | --- | --- |
| Énumérer des listes | `GET lists`, `ListsApi$lists$3.invokeSuspend` [E54] | `cursor`, `perPage`, `member`, `memberRelationship`, `sort` [E70] |
| Lire une liste | `GET list/{id}/entries`, `ListsApi$getEntries$3.invokeSuspend` [E53] | `cursor`, `perPage`, `filmId` répété, `sort`, filtres [E69] |
| Lire une watchlist | `GET member/{id}/watchlist`, `MembersApi$watchlist$3.invokeSuspend` [E55] | `cursor`, `perPage`, `filmId` répété, `sort`, filtres [E71] |

Les paramètres absents sont omis par les lambdas de construction de query
string [E69, E70, E71]. `ListEntriesRequester.getObservableRequest(cursor)`
et `WatchlistRequester.getObservableRequest(cursor)` injectent le curseur
et le LID de la liste ou de son propriétaire dans les paramètres construits
[E33, E34]. `ListEntriesResponse` déclare `next`, `items`, `itemCount`,
`metadata` et `relationships` [E24] ; la réponse abstraite de pagination
déclare aussi `next` et `items` [E40]. Un numéro de page n'est pas le
mécanisme observé sur ces chemins.

La taille locale par défaut d'`AbstractPaginatedRequest` est **20**, visible
dans son constructeur synthétique [E67]. Le builder d'énumération de listes
fixe explicitement **12** pour `perPage` : le smali charge `0xc`, le convertit
en `Integer`, puis le passe comme deuxième argument de
`ListsApi.ListsQueryParams` [E63]. Les builders d'entrées et de watchlist
passent un masque de paramètres par défaut qui laisse `perPage=null`
[E61, E62, E81, E82]. Les lambdas HTTP omettent alors ce paramètre ; ces
chemins laissent donc le serveur choisir la taille de page [E69, E71].
Ces constats ne prouvent ni le nombre réellement renvoyé ni la taille
choisie dans chaque écran.

### IMDb et TMDB

`ListEntry.film` est un `FilmSummary`. Le modèle conserve aussi `entryId`,
`rank`, `whenAdded`, les notes et leur indicateur de spoilers [E11].
`FilmSummary` déclare `id`, `name`, `releaseYear`, `link` et
`links: List<Link>` [E10]. Son sérialiseur déclare `links` comme élément
non optionnel : l'argument booléen d'`addElement` vaut `false`, ce qui
signifie que l'élément n'a pas de valeur par défaut dans ce descripteur
[E32]. Cela n'impose ni une liste non vide ni un lien pour chaque service.

`Link` porte `type`, `id`, `url`, `label` et `checkUrl` [E30]. L'inventaire
de `Link.Type` contient les sous-types `Imdb` et `Tmdb` [E60]. Il n'existe
donc pas seulement une URL textuelle à analyser : le schéma sait porter un
identifiant externe typé. Le modèle de détail `Film` comporte lui aussi
`links` [E12]. La coroutine de détail construit `GET film/{id}` [E73].

**Déduction.** Si la réponse de liste ou de watchlist remplit ces liens,
Stremlist peut résoudre les identifiants à partir de cette réponse, sans
requête de détail par élément. Si les liens requis sont absents, un
enrichissement complémentaire devient nécessaire pour les films concernés.
Le modèle Android seul ne permet pas de choisir entre ces deux cas. Il
ne garantit pas non plus que le client tiers reçoive les mêmes champs que
le client officiel. Les noms `id` de `FilmSummary` et `id` de `Link` ne
doivent pas être confondus : le second dépend du type de lien.

## TLS, pinning et autorités utilisateur

**Observé.** Le manifeste référence `@xml/network_security_config` et ne
déclare pas `android:debuggable=true` [E01]. La ressource est extraite du
même ZIP, puis décodée localement avec `aapt2 dump xmltree` :

- `base-config/trust-anchors` contient uniquement `certificates src="system"` ;
- `debug-overrides/trust-anchors` contient `certificates src="user"` ;
- aucun `pin-set` n'apparaît dans cette ressource ;
- des exceptions de trafic en clair visent des hôtes de développement.

Cette observation complémentaire est référencée **S01**, avec les hashes
de la ressource et de sa projection dans l'index. Elle ne possède pas
d'Evidence ID REA et n'est pas présentée comme une sortie REA.

La recherche de références à `okhttp3.CertificatePinner` récupère huit
classes utilisatrices, toutes dans OkHttp. Aucune classe Letterboxd n'est
renvoyée par cette recherche statique [E38]. Les configurations Ktor
examinées n'installent pas de pinning personnalisé [E14, E49, E50, E51].

**Déduction limitée.** Aucun pinning applicatif n'est mis en évidence dans
ce périmètre. Cela ne signifie pas que l'application de production accepte
une autorité utilisateur. Android réserve `debug-overrides` aux
applications débogables, selon sa
[documentation officielle](https://developer.android.com/privacy-and-security/security-config#debug-overrides).
Avec les ancres système observées, un proxy signé par une simple autorité
utilisateur peut donc être rejeté sans aucun pinning. Le parent doit
rapporter séparément les flags réels de l'application et le résultat TLS.
Aucun changement de confiance ou contournement n'est effectué ici.

## Comparaison avec la documentation primaire

La [documentation officielle Letterboxd](https://api-docs.letterboxd.com/),
consultée le 25 octobre 2026, réserve Password aux clients first party.
Elle prévoit Authorization Code pour les utilisateurs d'un client tiers,
Client Credentials pour les données publiques, puis Bearer et refresh
token. Elle précise que l'ancienne exigence de signature a été retirée.
Les chemins statiques examinés sont compatibles avec ces indications.

La même documentation annonce 20 éléments par défaut, 100 au maximum pour
les routes paginées étudiées et une limite de 100 000 objets par parcours
paginé. Elle marque `FilmSummary.links` comme déprécié, tout en décrivant
des liens IMDb/TMDB. Cette dépréciation rend nécessaire une validation du
contrat actuel pour le client tiers. Ces déclarations ne constituent aucun
test serveur dans cette investigation.

## Conséquences pour une intégration à grande échelle

Les points suivants sont des choix d'intégration proposés, et non des
capacités mesurées du service.

1. **Obtenir un client OAuth propre à Stremlist et ses conditions d'accès.**
   Ne pas transformer les identifiants du client Android en dépendance de
   production. L'autorisation d'analyser le téléphone et le compte ne
   fournit ni identité OAuth Stremlist ni quota partagé entre ses utilisateurs.
2. **Paginer jusqu'à `next` absent**, en sauvegardant des étapes de reprise.
   Ne pas déduire la fin du parcours du seul nombre d'éléments d'une page.
   Garder l'ordre de liste et le rang séparés de l'identité du film.
3. **Résoudre les liens externes sur les pages déjà reçues.** Si un détail
   est nécessaire, dédupliquer les LID avant enrichissement et réutiliser
   les correspondances globales LID ↔ IMDb/TMDB. Garder les appartenances
   et les contenus privés séparés par utilisateur.
4. **Régler le débit par client et par utilisateur**, avec des files de
   travail, un retry borné et des reprises après erreur. Aucun débit sûr
   n'est établi par les retry Android. Le partage des listes, les suppressions,
   l'accès privé et les révocations doivent rester cohérents après reprise.
5. **Limiter les renouvellements concurrents d'un même compte.** Le mutex
   local observé fournit un indice du problème traité par le client Android.
   Un backend distribué devra coordonner ses propres renouvellements et
   prendre en charge une éventuelle rotation, encore non observée ici.

Le coût minimal d'un import est la somme des pages de listes, d'entrées et
de watchlist, plus l'authentification, les métadonnées nécessaires et les
enrichissements manquants. Exemple **théorique**, sans mesure de débit :
20 000 utilisateurs avec 500 films de watchlist représentent 10 millions
d'entrées. Avec 100 éléments acceptés par page, cela donne 100 000 requêtes
de pages ; avec 20, 500 000. Ajouter un détail par entrée porterait
l'enrichissement à 10 millions de requêtes avant déduplication. La présence
effective des liens dans les pages est donc une question de premier ordre.

## Questions pour l'observation runtime du parent

| Question | Observation nécessaire |
| --- | --- |
| Quelles routes sont réellement utilisées ? | Comparer ouverture d'une liste, défilement, watchlist et énumération des listes ; relever hôte, méthode, chemin, `cursor` et `perPage` si un accès réseau autorisé le permet. |
| Les liens externes évitent-ils une requête par film ? | Sur plusieurs pages, relever uniquement les types de liens présents et leur taux d'absence ; comparer un objet de page à son détail. Ne pas exporter de jetons. |
| Les champs diffèrent-ils avec un client tiers ? | Vérifier avec des identifiants attribués à Stremlist ; une capture du client officiel ne tranche pas ce point. |
| Quel accès au contenu privé ? | Comparer listes et watchlist publiques et privées du compte autorisé, ainsi que leur visibilité avec et sans session. |
| Quelle durée et quelle rotation ? | Observer les métadonnées d'expiration, une reprise normale, un renouvellement et une déconnexion ; consigner la rotation sans conserver de valeurs dans le rapport. |
| Quelles erreurs doivent être gérées ? | Observer les erreurs ordinaires rencontrées ; demander les quotas et règles de limitation au fournisseur. Aucune charge de test n'est réalisée ici. |
| Quelle confiance TLS réelle ? | Confirmer les flags installés et distinguer rejet d'une autorité utilisateur, erreur de nom d'hôte et éventuel pinning. L'absence de capture HTTPS n'établit pas à elle seule un pinning. |
| Un import reprend-il sans perte ? | Examiner stabilité des LID, curseurs et rangs pendant des changements de liste ; la cohérence d'un parcours concurrent n'est pas établie statiquement. |

## Limites et état de couverture

| Sujet | État |
| --- | --- |
| Identité, version et hash de `base.apk` | Établis pour cette copie [E01] |
| Framework, configuration API et routes étudiées | Observés dans des méthodes ciblées |
| Pagination et schémas de données | Observés ; contenu serveur non vérifié |
| Password first party et mécanismes de reprise/refresh | Chemins statiques observés ; réussite et politique serveur inconnues |
| Signature additionnelle | Non observée sur les chemins cités ; recherche non exhaustive du binaire |
| Pinning | Non mis en évidence par la ressource et les références examinées |
| Confiance en une autorité utilisateur en production | Non démontrée ; configuration statique défavorable hors debug |
| IMDb/TMDB réellement présents dans les pages | Non vérifié |
| Accès tiers, quotas et capacité à grande échelle | Non vérifiés |

Les positions de source d'origine ne sont pas connues. Les noms de méthodes
Java issus de Kotlin peuvent être des alias JADX ; les index de surcharge
et descripteurs DEX conservés dans les JSON font foi pour cette analyse et
ce moteur. Les méthodes de coroutines peuvent produire du Java avec des
avertissements ou du smali de secours. Le rapport s'appuie sur les
déclarations, constantes et appels retrouvés ; il ne traite pas une
reconstruction Java imparfaite comme une exécution observée.

Deux lectures d'initialiseurs statiques échouent :
`AbstractPaginatedRequest.<clinit>` et `Link.Type.<clinit>`.
Elles restent non vérifiées. Les constats retenus sur la taille 20 et sur
les sous-types `Imdb`/`Tmdb` proviennent respectivement d'un autre
constructeur et d'un inventaire de membres réussis. Une première sélection
de `Link$Type` échoue aussi ; le nom exact `Link.Type`, fourni par
l'inventaire de la classe parente, fonctionne ensuite [E60]. Les erreurs
complètes sont conservées, sans répétition de l'appel inchangé.

Seul le `base.apk` est analysé. Les trois APK de configuration, les
bibliothèques natives qu'ils pourraient porter, la signature cryptographique
du paquet et les chargements dynamiques ne sont pas vérifiés. Les références
JADX sont des relations statiques récupérées, pas une couverture de tous
les appels possibles. Aucun utilisateur, appareil, session ou compte
supplémentaire n'est testé. Aucun code applicatif n'est changé ; la
vérification des parcours Stremlist ne s'applique donc pas à ce rapport
documentaire.

## Index des preuves

Les repères `E01`, etc. renvoient aux Evidence IDs REA et aux sélecteurs
précis ci-dessous. Ils ne désignent aucune observation runtime.

Les préfixes de sélecteurs `app.` et `api.` signifient respectivement
`com.letterboxd.letterboxd.` et `com.letterboxd.api.`. Les noms contenant
`$` sont conservés tels que retournés par REA. Les signatures et
descripteurs DEX complets sont dans les JSON.

| Repère | Sélecteur | Evidence ID | JSON privé |
| --- | --- | --- | --- |
| E01 | `inspect_android_package` | `ev_29cae4e504cd0dbc743715ced1c0f1465453eaba79a2f001de2dd20a44060161` | `001-package.json` |
| E02 | `search_android_classes` | `ev_cdc333c466c679233a48c0bb775346a475c3b56c33300b28163f7d87cd4f56ff` | `002-classes.json` |
| E04 | `app.api.auth.AccessTokenDataManager : inventaire` | `ev_326320c4ca21716dd119aeb17b60a0416165170a69043fc9b5549a81ede65e56` | `004-access-token-class.json` |
| E10 | `api.model.FilmSummary : inventaire` | `ev_3cae598701a3a0d199ae66d4202a0ede754c02b7fa9084b7e93a00a6a29fdd08` | `010-film-summary-class.json` |
| E11 | `api.model.ListEntry : inventaire` | `ev_93f16ea154003e8cc6e38e54c1c3b54707ebd4d1b4788284bd293050ab199a66` | `011-list-entry-class.json` |
| E12 | `api.model.Film : inventaire` | `ev_74a2ff88fd9f1b3eeb4a2cd7af5282f64e09e4f7f5cb3c156373130d4bc162f7` | `012-film-class.json` |
| E13 | `app.api.LetterboxdAPIManager.<init> [surcharge 0]` | `ev_b0dc3d4893ed31460d9f1b1deeb0a6975eb9a2d456b25a062a98c0572e041b0d` | `013-api-manager-init.json` |
| E14 | `app.api.LetterboxdAPIManager.httpClientConfig$lambda$0 [surcharge 0]` | `ev_a4f3c7fc7746cf2f2673a0575441f7d183e4dbfb411b2638f57779dc1e6a876d` | `014-http-config.json` |
| E15 | `app.api.LetterboxdAPIManager.buildPasswordFlowClient [surcharge 0]` | `ev_4581a7841e790fc1db049b3fe268bbf1a89a4e7707e1a2b04428d77baf176fe4` | `015-password-client.json` |
| E16 | `app.api.LetterboxdAPIManager.buildCredentialsFlowClient [surcharge 0]` | `ev_0947214545321162f4188c69495eccbde8b2537e9e0f7a4a81f5282950df17e1` | `016-credentials-client.json` |
| E24 | `api.model.ListEntriesResponse : inventaire` | `ev_aee8121e75b2d7aae4b120511ea331a3738c0394936b5743b3fdb6241c9b6040` | `024-list-entries-response-class.json` |
| E30 | `api.model.Link : inventaire` | `ev_996adb9e3952a5e9a01837f6b39711ae8afdb8e3d4c0174be70714e1c5c8b97c` | `030-link-class.json` |
| E32 | `api.model.FilmSummary$$serializer.<clinit> [surcharge 0]` | `ev_1e3a7c361cbe7c07a86b693b4c38ada2bd7d77046baa8e2cd9fd49e612df8139` | `032-film-summary-descriptor.json` |
| E33 | `app.api.requester.WatchlistRequester.getObservableRequest [surcharge 0]` | `ev_0988cc8aee6ca5f617f0240ec8a2f39567a1a746d9ef96c0266fd8b19ec9a90a` | `033-watchlist-request.json` |
| E34 | `app.api.requester.ListEntriesRequester.getObservableRequest [surcharge 0]` | `ev_456a6f9347ce2a217eae726eb250f1765d17541a873538a4d390e3d583e1f128` | `034-list-entries-request.json` |
| E38 | `okhttp3.CertificatePinner : références entrantes` | `ev_d41cd59c47ce891d11a3e693521e0fc264d3725249c6344fdfcc19456c8eb7cc` | `038-certificate-pinner-xrefs.json` |
| E40 | `app.api.models.AbstractPaginatedResponse : inventaire` | `ev_4181a4876f35bdd2029fafb8fe92ea01ceef4780871bb517e74fa6d01b14fe50` | `040-abstract-response-class.json` |
| E43 | `api.security.OAuthPasswordFlowClient.authenticate_yxL6bBk$lambda$0$0 [surcharge 0]` | `ev_3396e606eec035d2f55ac714236f5ec0c5e2766ab5cf461c508c33adc1a5fbe6` | `043-password-form.json` |
| E44 | `app.api.LetterboxdAPIManager.m10184authenticateBWLJW6A [surcharge 0]` | `ev_9e500ae80fc7fc5ea8930d8b9b9dc8a15cf6107d7a83ffea0512b8a620f7c665` | `044-manager-authenticate.json` |
| E45 | `app.api.LetterboxdAPIManager.m10185signInWithTokenIoAF18A [surcharge 0]` | `ev_e823465db5d7ad560883d0a9837605165546bf922ace4b24c471a29a44ff666b` | `045-manager-sign-in-token.json` |
| E46 | `app.api.LetterboxdAPIManager.httpClientConfig$lambda$0$2 [surcharge 0]` | `ev_dcf9cee2f1e1580b8858a25a0ea2101d7f9d864e7b076ca488e6344d14ef67ac` | `046-default-headers.json` |
| E47 | `app.api.LetterboxdAPIManager.httpClientConfig$lambda$0$1 [surcharge 0]` | `ev_40989ad8bd8c323660aef09eecdbc434747d3a1b583edfbe1990facb574ddb44` | `047-retry-config.json` |
| E48 | `app.api.LetterboxdAPIManager.httpClientConfig$lambda$0$1$0 [surcharge 0]` | `ev_6a6a6e80bf525a9f62f9bbcc63fe6b1e1be600ab106fa2b32a406c0463d5eea4` | `048-retry-predicate.json` |
| E49 | `api.support.Configuration.client$lambda$0 [surcharge 0]` | `ev_c17cc651ec07378ac0193acc8d395b50c11b957ac303edc167df8d0b19c063f6` | `049-client-config.json` |
| E50 | `api.security.AbstractOAuthFlowClient.client$lambda$0 [surcharge 0]` | `ev_5c55c0fd609edcd9073f0677708791e34d66c4c8a0188739629f84f4fff382f9` | `050-oauth-client-config.json` |
| E51 | `api.support.Configuration.<init> [surcharge 0]` | `ev_8a9c2cb620db119656b0bb787765e46c31669f49f72d498fcadb4bfb2e92777b` | `051-client-constructor.json` |
| E53 | `api.ListsApi$getEntries$3.invokeSuspend [surcharge 0]` | `ev_1b39bb6df64fadad6c065c751007082754a5e59dda2b9908f745b64102b0867d` | `053-list-entries-http.json` |
| E54 | `api.ListsApi$lists$3.invokeSuspend [surcharge 0]` | `ev_da8ea02e147befe840788ae378d7cfaae3a145676b6da195a436af56d6b2d659` | `054-lists-http.json` |
| E55 | `api.MembersApi$watchlist$3.invokeSuspend [surcharge 0]` | `ev_695c7aec86dba1562ab5a09cb931cd8871ef1645af498583e8825cf23ed6ec72` | `055-watchlist-http.json` |
| E56 | `api.security.OAuthAccessTokenManager.m10151authorizegIAlus [surcharge 0]` | `ev_d188870f6cb14c68432a1e6b126763def43c56c3f907eca3c16bd3e33fd8e442` | `056-token-authorize.json` |
| E57 | `api.security.OAuthAccessTokenManager.m10153refreshTokengIAlus [surcharge 0]` | `ev_8e03783660efce2dd3e3c6d9251861da97129cefecf74c445dd72c4e949b1125` | `057-token-refresh-guard.json` |
| E60 | `api.model.Link.Type : inventaire` | `ev_85636c2adb3d969da44499eed5bef40c9ee43d388247c9cc401611dd08c3805c` | `060-link-type-corrected.json` |
| E61 | `app.model.filter.builder.WatchlistRequestBuilder.build [surcharge 0]` | `ev_296563f23871a0d5561d0ccb43b4b9a0b26433ae49a7b1679721af6681168a8b` | `061-watchlist-build.json` |
| E62 | `app.model.filter.builder.ListEntriesRequestBuilder.build [surcharge 0]` | `ev_3b38ba595fe9799f8ad2637c19cef25c9c115758d933bf7c5292945bd1baae78` | `062-list-entries-build.json` |
| E63 | `app.model.filter.builder.ListsRequestBuilder.build [surcharge 0]` | `ev_431e1999177ade9312e6b66edfacf2d80c5fc278b147ac0d9d68980a6f3beabb` | `063-lists-build.json` |
| E64 | `api.security.OAuthAccessTokenManager.m10150startRefreshTimerVtjQ1oo [surcharge 0]` | `ev_f457dac92f2129baae21be8061140c7caff9d0cf1738cbee8c05ab7d412b2b42` | `064-token-timer.json` |
| E67 | `app.api.models.AbstractPaginatedRequest.<init> [surcharge 1]` | `ev_61e3137ec5432ce4eefc7391b901d03c0a83e1bad8a86ecc2f8de8211108b726` | `067-page-default.json` |
| E69 | `api.ListsApi$getEntries$3.invokeSuspend$lambda$0$0 [surcharge 0]` | `ev_be88cc26fc036b0b77291c59ba09f350e8461271d9907e194c3e68b0ad07ee3d` | `069-list-query.json` |
| E70 | `api.ListsApi$lists$3.invokeSuspend$lambda$0$0 [surcharge 0]` | `ev_ecee48e26157e31621e548e8ffd9b22575fdb319eb016289f9ede456708680a9` | `070-lists-query.json` |
| E71 | `api.MembersApi$watchlist$3.invokeSuspend$lambda$0$0 [surcharge 0]` | `ev_0e8002e355b891dbc394e713f1b4e9eed0e35331fe382594d092206961f57e4f` | `071-watchlist-query.json` |
| E72 | `api.security.OAuthAccessTokenManager.authorizationHeader [surcharge 0]` | `ev_c39757f08e01d2f80ff05cd28e9b1480d3c8deffd174e497f9932617fcbf2f58` | `072-bearer-header.json` |
| E73 | `api.FilmsApi$getFilmDetails$3.invokeSuspend [surcharge 0]` | `ev_d3ebf8d86c32aa07d2c444d79f02d8b97bfea96f4d87e2436554a2271f6c21fd` | `073-film-detail-http.json` |
| E74 | `api.security.OAuthAccessTokenManager.m10152refreshTokenIoAF18A [surcharge 0]` | `ev_879d687132f8699354f5a8138989bbdaaa4f89e3b7163b9d6591085f05c7d01e` | `074-token-refresh-main.json` |
| E76 | `api.security.SecuritySchemeKt.m10162oauthClientFHKeTTw [surcharge 0]` | `ev_dc65c67a6e2143093b7bfb1d9abc6df43c6d91b756952512c9176ad57f776215` | `076-security-default-password.json` |
| E77 | `api.security.SecuritySchemeKt.m10165oauthClientFHKeTTw$default [surcharge 0]` | `ev_dc9b53ba9162a3a13b8f6dfd5b9038bddc5af10ad11c0d9fb6d46ea74fefe421` | `077-security-default-duration.json` |
| E81 | `api.MembersApi.WatchlistQueryParams.<init> [surcharge 1]` | `ev_f1ac00e776dbc83870ccb999d8bd4f0645fda669d4bbd113700a9034bda229e2` | `081-watchlist-page-default.json` |
| E82 | `api.ListsApi.GetEntriesQueryParams.<init> [surcharge 1]` | `ev_f0465f3cec9e468ec97f4215634e24f3f4cfb57f6509c25f99d7d940a4250a8b` | `082-list-entries-page-default.json` |
| E83 | `api.security.OAuthAccessTokenManager$refreshToken$2$1.invokeSuspend [surcharge 0]` | `ev_0662054a7d7844722275ae59497f9c0eba5dea56c8cd9a7c2e02418c97b6fe32` | `083-refresh-request.json` |
| E84 | `api.support.Configuration.<init> [surcharge 1]` | `ev_05f1d8d96587b80156edb810428b487765908c856b154d4bd1811a481fc087dc` | `084-config-default-constructor.json` |
| E86 | `api.security.OAuthAccessTokenManager$refreshToken$2$1.invokeSuspend$lambda$0$0 [surcharge 0]` | `ev_1e3fe0fb8d9ba04e91bf5e70ccca1e0b998e5f51d3af2aa6c21d9bb35bcbe60a` | `086-refresh-form.json` |

**S01, ressource réseau complémentaire.** Commande : `aapt2 dump xmltree`
avec `--file res/xml/network_security_config.xml` sur le même APK.
Version : Android Asset Packaging Tool 2.19-debian. Le hash SHA-256 de la
ressource compilée est
`b3d2aec3d4dc00f0cd144a5f66a9734c2608f171fef4b86635cdaaafefe4c7d7`.
Le hash de la projection texte est
`1713a66680279eb06a2526eaaf8139f2b3687c430a6ad0af6220ec26d177169c`.
Les fichiers `network_security_config.axml`,
`network_security_config.aapt2.txt` et
`network_security_config.provenance.json` sont conservés dans le même
dossier privé. S01 complète le manifeste de E01.
