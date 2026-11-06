# Letterboxd : investigation web pour Stremlist

Date : 25 octobre 2026, environ 22:44 à 22:53 UTC. Périmètre : site web réel, lecture seule. Le téléphone et l'APK sont hors de cette investigation.

## Conclusions utiles

- **Une intégration des collections publiques est techniquement possible avec le HTML observé.** Les deux premières pages de la watchlist et de la liste testées répondent sans connexion. Le HTML contient déjà les cartes, leur ordre, les URL de films et leurs identifiants Letterboxd. Il n'est pas nécessaire d'exécuter React pour extraire ces données de cet échantillon. [Watchlist](https://letterboxd.com/fcbarcelona/watchlist/), [liste](https://letterboxd.com/official/list/letterboxds-top-500-films/) ; preuves E1 et E2.
- **Les identifiants Letterboxd ne sont pas des identifiants TMDB.** Harakiri a `id=43015`, `uid=film:43015`, `lid=1NTU`, TMDB `14537` et IMDb `tt0056058`. La fiche HTML donne les identifiants externes ; le JSON de film testé ne les donne pas. [Fiche](https://letterboxd.com/film/harakiri/), [JSON](https://letterboxd.com/film/harakiri/json/) ; E3.
- **La pagination a un coût distinct selon la collection.** La watchlist testée affiche 28 films par page et 49 pages pour 1 355 films. La liste testée affiche 100 films par page, en grille comme en détail, et cinq pages pour 500 films. Deux pages successives ont été lues pour chaque collection, pas la collection complète. E1, E2 et E4.
- **La voie authentifiée reste non vérifiée.** L'import habituel a réussi, mais le site affiche une session déconnectée. L'URL d'export du compte affiche un formulaire de connexion. Aucune connexion Bitwarden, demande 2FA ou intervention utilisateur n'a été déclenchée. [Accès aux données du compte](https://letterboxd.com/settings/data/) ; E4 et C7.
- **Le web ne donne pas une garantie de capacité pour 10 000 à 50 000 utilisateurs.** Une synchronisation complète fréquente peut produire des millions de requêtes de documents, avant même la résolution IMDb/TMDB. Les preuves ne donnent ni quota, ni débit soutenable, ni engagement de disponibilité. L'accès à l'API officielle se demande séparément et n'est pas garanti. [Accès API officiel](https://letterboxd.com/api-beta/) ; E3 et C5.

## Conditions et méthode

REA CLI installé : `rea@6.7.0`. Navigateur : Chrome `154.0.8037.92` sur l'environnement Linux observé. Toutes les commandes navigateur sont passées par `~/.local/bin/agent-browser`, avec l'unique session `letterboxd-web-20261025-87ec` et l'import de connexion habituel.

Les consignes `rea.md`, `agent-browser.md`, le skill `reverse-engineer-anything` et ses références `runtime-observation.md`, `connection-and-recovery.md` et `evidence-workflows.md` ont été lus. Aucun outil du catalogue MCP REA, aucune modification de configuration globale et aucun autre agent n'ont été utilisés.

Les actions sont des navigations GET, des observations CDP, des lectures ciblées du DOM et des captures HAR. Le consentement publicitaire a été refusé dans cette session. Aucun formulaire de compte, note, liste, like ou watchlist n'a été soumis. Les champs d'action présents dans les réponses n'ont pas été invoqués.

Aucun challenge anti-bot visible n'a été rencontré pendant ces parcours. Les documents sélectionnés dans les quatre preuves HAR répondent tous HTTP 200. Cela ne prouve pas l'absence de protection ni de limitation de débit. Aucune recherche de seuil, boucle de requêtes, résolution de challenge ou tentative de contournement n'a été effectuée.

La session dédiée a été fermée avec `agent-browser --session letterboxd-web-20261025-87ec close`. Aucun autre navigateur n'a été fermé.

Les fichiers bruts sont hors du dépôt :

```text
~/.local/share/rea/investigations/letterboxd-20261025/web/
```

Le dossier est privé (`0700`) et les fichiers sont en `0600`. Les HAR et certaines réponses contiennent des données de session ; ils ne doivent pas être copiés dans un PR. Aucune valeur de cookie, jeton, mot de passe ou CSRF n'est reproduite ici. Les extractions affichées ne sélectionnent que des champs de films, des noms de champs et des en-têtes de cache autorisés.

## Parcours et formats observés

### Watchlist publique

Source primaire : [watchlist de fcbarcelona](https://letterboxd.com/fcbarcelona/watchlist/) et [page 2](https://letterboxd.com/fcbarcelona/watchlist/page/2/). E2, enregistrements HAR 273 et 562 ; inspection CDP C4.

Observations :

- Le profil annonce 1 355 films à voir. Les pages 1 et 2 contiennent chacune 28 cartes de films dans le HTML initial et dans le DOM rendu.
- La navigation propose `Older`, puis `/fcbarcelona/watchlist/page/2/`, avec un lien vers la page 49. La page 2 propose aussi `Newer` vers la première page.
- La première carte de la page 1 est Miami Vice '85 : `lid=UpRA`, `uid=film:1344579`, lien `/film/miami-vice-85/`. La première de la page 2 est Once Upon a Time in Mexico : `lid=28LM`, `uid=film:51037`.
- Les liens de tri exposés comprennent `by/name/`, `by/popular/`, `by/date-earliest/`, `by/release/` et `by/rating/`. Leur présence est observée ; leurs résultats n'ont pas été testés. Le menu indique le tri par ajout récent pour la vue par défaut.

Inférence : suivre le lien de page suivant est plus robuste que supposer une taille de page universelle. Ne lire que la première page peut trouver des ajouts récents, mais ne permet pas de détecter toutes les suppressions dans les pages anciennes. Les suppressions et les changements de tri n'ont pas été provoqués pour cette étude.

### Annuaire de listes et liste publique

Sources primaires : [listes de fcbarcelona](https://letterboxd.com/fcbarcelona/lists/), [Top 500 en grille](https://letterboxd.com/official/list/letterboxds-top-500-films/), [page 2](https://letterboxd.com/official/list/letterboxds-top-500-films/page/2/) et [vue détaillée](https://letterboxd.com/official/list/letterboxds-top-500-films/detail/). E1 et E4.

Observations :

- L'annuaire du membre est accessible sans connexion. Il expose une liste nommée et son URL `/fcbarcelona/list/movies-everyone-should-watch-at-least-once/`. Ce membre n'ayant qu'une liste visible, la pagination d'un annuaire de nombreuses listes reste non vérifiée.
- La Top 500 contient 100 cartes sur la page 1, avec `data-list-index` de `0` à `99`. La page 2 contient 100 cartes de `100` à `199`. Harakiri ouvre la première page ; Oldboy ouvre la deuxième.
- Les liens de grille suivent `/official/list/letterboxds-top-500-films/page/N/`. La vue détaillée expose `/official/list/letterboxds-top-500-films/detail/page/N/`. Sa première page contient également 100 films.
- La vue détaillée examinée n'expose pas de liens IMDb/TMDB de films, ni d'attributs `data-tmdb-id`, `data-imdb-id` ou `data-film-id`. Elle conserve les mêmes identifiants Letterboxd sur les cartes.
- Le navigateur charge séparément `/csi/list/207314/comments-section/?esiAllowUser=true` en HTML. `207314` est le nombre observé dans cette route de commentaires ; cela ne démontre pas une règle générale de conversion des identifiants de listes.

Limite : les cinq pages n'ont pas été parcourues. Le nombre total et la dernière page proviennent de l'interface ; seules les deux premières pages sont corroborées par leurs réponses.

### Identifiants dans le HTML

Les cartes utilisent `data-component-class="LazyPoster"` et contiennent notamment :

```json
{
  "data-item-name": "Harakiri (1962)",
  "data-item-slug": "harakiri",
  "data-item-link": "/film/harakiri/",
  "data-postered-identifier": {
    "lid": "1NTU",
    "uid": "film:43015",
    "type": "film",
    "typeName": "film"
  },
  "data-details-endpoint": "/film/harakiri/json/",
  "data-list-index": "0"
}
```

Il s'agit d'une présentation décodée des attributs, pas de la syntaxe exacte des guillemets HTML. Les valeurs sont corroborées par E1 et E3. Le HTML enregistré contient déjà ces attributs. L'extraction hors ligne est conservée dans `31-observation-summary.json`, avec le script `summarize-evidence.cjs`.

L'attribut historique `data-film-id` n'est pas présent dans les pages de collection examinées. Un extracteur qui dépend uniquement de cet attribut manque les cartes de cet échantillon. Le `uid` contient un espace de noms (`film:`) ; conserver cet espace de noms évite de confondre le nombre interne avec un identifiant externe.

### HTML, JSON de film et JSON d'affiche

| Ressource réelle | Réponse observée | Données utiles | Limite |
| --- | --- | --- | --- |
| `/<membre>/watchlist/` | HTTP 200, `text/html` | Appartenance, ordre, liens, identifiants Letterboxd | Pagination et analyse HTML |
| `/<membre>/list/<slug>/` | HTTP 200, `text/html` | Appartenance, ordre, indices, identifiants Letterboxd | Pas un contrat d'API versionnée |
| `/film/harakiri/` | HTTP 200, `text/html` | `data-tmdb-id="14537"`, lien IMDb `tt0056058`, lien TMDB `/movie/14537/`, JSON-LD présent | Un film vérifié ; coût supplémentaire si la correspondance manque |
| `/film/harakiri/json/` | HTTP 200, `text/json` | `id=43015`, `uid=film:43015`, `lid=1NTU`, titre, année, durée, réalisateur, images | Aucun champ IMDb/TMDB dans cette réponse |
| `/film/harakiri/poster/std/125/?k=fa62dd92` | HTTP 200, `text/json` | Champs `url`, `url2x`, `shouldObfuscate` | Résolution d'affiche, pas contenu de collection ni correspondance IMDb/TMDB |

Sources : [fiche de film](https://letterboxd.com/film/harakiri/) et [JSON de film](https://letterboxd.com/film/harakiri/json/), E1 et E3. Le JSON de film contient aussi les noms de champs `csrf`, `filmlistAction` et `watchlistAction`. Aucune valeur CSRF n'a été affichée et aucune action n'a été exécutée. La présence de ces champs ne démontre pas une autorisation d'écriture anonyme.

Aucun endpoint JSON de **collection complète** n'a été établi. Les JSON observés concernent un film et une affiche. L'étude n'a pas effectué d'inventaire exhaustif des bundles JavaScript ni d'énumération d'URL supposées. Elle ne conclut donc pas qu'un endpoint de collection n'existe pas.

## Authentification et API officielle

La page d'accueil et les pages publiques affichent `Sign in`. La lecture de [l'URL de données du compte](https://letterboxd.com/settings/data/), indiquée par la page API officielle, répond HTTP 200 avec le titre `Sign in` et un formulaire contenant des champs `username` et `password`. L'URL reste `/settings/data/` : ce n'est pas une preuve de redirection HTTP. E4, enregistrement 436, et C7.

L'absence de connexion a été signalée dans le suivi de tâche avant toute éventuelle demande utilisateur. Aucune demande n'a été lancée. Les listes privées, l'export CSV effectif, les cookies de connexion, la durée de session, le mécanisme de connexion et les parcours 2FA restent non vérifiés.

La [page officielle d'accès API](https://letterboxd.com/api-beta/) indique que l'accès se demande par courriel avec le projet et son usage, sans garantie d'acceptation. Elle exclut actuellement plusieurs usages, dont les projets d'analyse, de visualisation ou de recommandation, les usages LLM/GPT, les projets privés/personnels et la reproduction de fonctions payantes actuelles ou prévues. Elle renvoie vers l'import/export pour les données du compte, vers les flux RSS de profil pour de nouvelles activités, et vers TMDB pour les métadonnées générales. E3, enregistrement 0, et C5.

Inférence : la qualification précise de Stremlist doit être présentée à Letterboxd pour savoir si un accès officiel est possible. La lecture publique du HTML et un éventuel accès mobile ne démontrent pas l'existence d'un accès API serveur approuvé, ni d'un quota utilisable par Stremlist. Le RSS mentionné n'a pas été testé et n'est pas établi comme un remplacement de la watchlist complète.

## Cache et volumes pour 10 000 à 50 000 utilisateurs

### En-têtes réellement relevés

| Réponse sélectionnée | `Cache-Control` | Autres observations |
| --- | --- | --- |
| Watchlist, pages 1 et 2 | `no-store` | `Age: 0`, `CF-Cache-Status: DYNAMIC` |
| Liste Top 500, grille pages 1 et 2, détail page 1 | Absent de ces réponses | `Age` positif, `CF-Cache-Status: DYNAMIC` |
| Fiche HTML Harakiri | `s-maxage=300` | `Age: 0`, `CF-Cache-Status: DYNAMIC` |
| JSON Harakiri | `no-store` | `Age: 0`, `CF-Cache-Status: DYNAMIC` |
| JSON d'affiche Harakiri | `max-age=31536000` | `CF-Cache-Status: HIT`, `Last-Modified` présent |

E1 à E4 ; en-têtes sélectionnés conservés dans `31-observation-summary.json`. Aucun `ETag` ni `Last-Modified` n'est présent sur les réponses de collections sélectionnées. Une requête conditionnelle n'a pas été testée. Un `Age` positif ne donne pas, seul, la politique ou la fraîcheur de la liste. Le cache long d'une affiche ne s'applique pas à l'appartenance d'une collection. Ces valeurs décrivent ces réponses anonymes à cet instant, pas toutes les variantes authentifiées.

### Calculs de dimensionnement, pas mesures de charge

Pour `U` collections distinctes, `S` films, `P` films par page et `R` synchronisations complètes par jour :

```text
requêtes de documents par jour = U × ceil(S / P) × R
```

| Hypothèse explicite | 10 000 utilisateurs | 50 000 utilisateurs |
| --- | ---: | ---: |
| Une liste de 500 films chacun, 100/page, une synchronisation/jour | 50 000/jour | 250 000/jour |
| Même liste, une synchronisation/heure | 1 200 000/jour | 6 000 000/jour |
| Une watchlist de 1 355 films chacun, 28/page, une synchronisation/jour | 490 000/jour | 2 450 000/jour |
| Même watchlist, une synchronisation/heure | 11 760 000/jour | 58 800 000/jour |

La taille de watchlist est celle de l'exemple observé, pas une moyenne d'utilisateurs. Ces calculs supposent que tous les comptes sont actifs et distincts. Ils excluent les reprises, la découverte des listes, la résolution d'identifiants et les ressources du navigateur. Ils ne démontrent pas que Letterboxd accepte ces volumes. Les centaines de requêtes publicitaires et d'images des HAR ne sont pas utilisées comme coût nécessaire d'une synchronisation serveur.

### Choix d'architecture proposés, encore à valider

1. **Séparer collection et correspondance de film.** Une collection garde ses identifiants Letterboxd et son ordre. Une table globale relie `film:43015` / `1NTU` à IMDb/TMDB, avec provenance et date de vérification. Le JSON de film testé ne remplace pas la lecture de la fiche HTML pour cette correspondance.
2. **Résoudre une fois par film distinct.** Sans table commune, 500 films par utilisateur donnent jusqu'à 5 ou 25 millions de résolutions au premier chargement. Si ces utilisateurs partagent exactement les mêmes 500 films, une table commune ramène le besoin logique à 500 résolutions, sous réserve du mode d'accès retenu. Ne pas lire une fiche ou son JSON pour chaque film à chaque ouverture du catalogue.
3. **Mutualiser les accès identiques.** Plusieurs installations ou utilisateurs suivant la même liste publique peuvent partager un travail de synchronisation. La clé doit distinguer propriétaire, liste, tri, filtres, vue et pagination. Une session authentifiée exige une séparation des données par utilisateur ; la session de Léo n'est pas un mécanisme d'accès partagé pour le service.
4. **Choisir une cadence explicite.** Le `no-store` observé ne fournit pas un TTL réutilisable pour un cache HTTP partagé de watchlist. La persistance métier, la durée de conservation et la cadence doivent être définies avec le mode d'accès retenu. Un TTL proposé par Stremlist ne devient pas une politique annoncée par Letterboxd.
5. **Conserver un résultat complet et daté.** Dédupliquer les films entre pages, conserver le dernier état complet si une page échoue, et distinguer une absence confirmée d'une lecture partielle. Une collection modifiée pendant le parcours peut déplacer les frontières de pages ; cela est une inférence, sans mutation provoquée ici.
6. **Mesurer avant de promettre une fraîcheur.** Quota officiel, taux d'échec, latence, détection des suppressions et volumes de films distincts restent à établir. Aucun nombre de requêtes/seconde sûr ne découle de cette étude.

## Couverture et limites

| Question | État | Limite restante |
| --- | --- | --- |
| Lecture de watchlist publique | Partiellement vérifiée | Deux pages d'un compte ; pas de parcours complet |
| Liste publique et ordre | Partiellement vérifiés | Deux pages en grille, une en détail, un exemple de liste |
| Annuaire public des listes | Partiellement vérifié | Un membre avec une seule liste ; pagination non testée |
| Identifiants Letterboxd / IMDb / TMDB | Vérifiés pour Harakiri | Un film ; cas sans IMDb, doublons, séries et variantes non couverts |
| JSON web accessible sans connexion | Vérifié pour un film et une affiche | Aucun contrat d'API ni endpoint de collection établi |
| Authentification exigée pour l'export du compte | Formulaire observé | Export réel et données privées non accessibles dans cette session |
| Parcours authentifié / 2FA | Non vérifié | Session importée déconnectée ; aucune demande déclenchée |
| Cache HTTP | Observé sur les réponses sélectionnées | Pas de test conditionnel, de variation connectée ou de répétition dans le temps |
| Charge 10k à 50k | Modèle arithmétique uniquement | Aucun test de charge, quota ou capacité établis |

Une inspection REA de huit secondes lancée pendant la navigation vers le JSON a échoué avec `target_unavailable`, raison `target_changed`. L'erreur est conservée dans `19-film-json-live-inspection.json` ; elle n'a pas été répétée. L'accès au JSON est corroboré par l'observation navigateur et le HAR E3, mais ce résultat n'est pas présenté comme une capture CDP réussie de cette transaction.

Les inspections CDP ne voient pas le réseau antérieur à leur attachement et filtrent les origines hors de `https://letterboxd.com`. Les preuves HAR sont des enregistrements du producteur : REA les décode hors ligne, ne rejoue aucune URL et ne leur ajoute pas une attribution d'exécution ou une authenticité de déploiement. Les observations navigateur du même parcours apportent le contexte, sans supprimer cette limite.

Le dépôt n'a reçu que ce rapport. Aucun changement de comportement de Stremlist et aucun commit n'ont été effectués. La vérification applicative `verify-stremlist` n'a pas été exécutée, car aucune fonction de l'application n'a été modifiée.

## Preuves et commandes

Tous les chemins de cette section sont relatifs au dossier privé indiqué plus haut. `32-manifest.json` contient les SHA-256 complets des fichiers de preuve et des extractions. Les empreintes de texte de réponse dans `31-observation-summary.json` sont calculées sur le texte UTF-8 retenu par REA, pas sur les octets HTTP originaux. Les tailles déclarées dans le HAR ne sont pas utilisées comme tailles de corps décodé.

### Preuves HAR principales

| Référence | Fichier REA | Enregistrements sélectionnés | Evidence ID |
| --- | --- | --- | --- |
| E1 | `09-list-har-evidence.json` | 37, 193, 196, 246 sur 454 | `ev_f1ecb42fc894ff81e04b2cae70a01629fdd78b188cc0601cf6c9b7d2612e175f` |
| E2 | `15-watchlist-har-evidence.json` | 0, 273, 562 sur 854 | `ev_cd1cab7c7214734f5d694e3391f288dbf8cb40325137e5bb98fd67e6096dae45` |
| E3 | `23-api-film-har-evidence.json` | 0, 165, 480 sur 481 | `ev_289f382a04d1647b60d7a888adbf76e19eec3396b415097046fa6e8768254edc` |
| E4 | `30-detail-directory-auth-har-evidence.json` | 0, 183, 436 sur 592 | `ev_f76a253aaf8fb86ed4ec12cc292517bc122f4cc5b6a65a0bfa6b8571893c742e` |

SHA-256 des captures sources :

```text
07-public-list.har
d3d7cca316b35bd17458b98cbe1b65632eb7002af1e3d8699b2fd3f119e1cded
13-public-watchlist.har
3de68a1d4c7f27ef6e757b23a78380ca22c4a6cce91d9852b366552fbba47765
21-api-film.har
02e0e387a6c0650429a01e69d80f81e1d39c6f2add2edd1713ec9c3a58f7a754
28-detail-directory-auth.har
b5f2bb4954da98585763ea8d751483815b5284245fd29040f772dd044836bd9a
```

### Preuves CDP complémentaires

| Référence | Fichier | Evidence ID |
| --- | --- | --- |
| C0, découverte de cible | `01-targets.json` | `ev_7154eb15e393a36ee61f71dabbab310610fe9fba1e47f3c2982153cfdf34ca0d` |
| C1, accueil déconnecté | `02-home-inspection.json` | `ev_c365715a9e026728ade158703bba748b05f4bee32b1561083690284e5d5ac1a6` |
| C2, navigation publique | `03-public-list-navigation.json` | `ev_1f060ede22cb6f9ecbd9fac5e61216c68fda89a20a41688b4f80dd2f9e0abb94` |
| C3, liste | `05-list-page1-inspection.json` | `ev_6395b7d0c542e9f19f0dcec7fb4f0e1b61f58c3751bca31290bbe31a89331f11` |
| C4, watchlist | `11-watchlist-page1-inspection.json` | `ev_44eb6ffc464d36e8246487b4c75a1a0e9983be6ebb239c45f419d258347d71a9` |
| C5, accès API | `16-api-access-inspection.json` | `ev_c6efa53f6f04fa729e6b68f6b0d0cc508499b070249bd799613c95e0c44d025b` |
| C6, fiche de film | `18-film-inspection.json` | `ev_da8ee4378bb25b45195d8df3726863eb1c9c8a7efe6371a92905df88123085f6` |
| C7, connexion exigée | `27-auth-gate-inspection.json` | `ev_d9578367236c7d2294ede0f2a5e993edb4d2cdf8a0d3359509509bc2190d0529` |

Commandes REA utilisées, avec variables représentant le point CDP et la cible retournés par la session désormais fermée :

```sh
INV="$HOME/.local/share/rea/investigations/letterboxd-20261025/web"
# CDP_URL provient de :
~/.local/bin/agent-browser --session letterboxd-web-20261025-87ec get cdp-url
# TARGET = 4411852EE535B8C44CE773217F3BD90A

rea list-browser-targets "$CDP_URL" \
  --allowed-origins https://letterboxd.com --format json --full-output

# Accueil, liste, watchlist et fiche de film, après chargement de chaque page :
rea inspect-web-page "$CDP_URL" "$TARGET" \
  --allowed-origins https://letterboxd.com \
  --include-accessibility-text --include-json-body-shapes \
  --format json --full-output

# Page API et formulaire de connexion : même commande sans --include-json-body-shapes.
rea inspect-web-page "$CDP_URL" "$TARGET" \
  --allowed-origins https://letterboxd.com \
  --include-accessibility-text --format json --full-output

rea observe-web-session "$CDP_URL" "$TARGET" \
  --allowed-origins https://letterboxd.com --observation-ms 12000 \
  --format json --full-output

# Appel échoué pendant la navigation : target_changed, pas d'Evidence ID.
rea inspect-web-page "$CDP_URL" "$TARGET" \
  --allowed-origins https://letterboxd.com --observation-ms 8000 \
  --include-json-body-shapes --format json --full-output

rea inspect-web-network-capture "$INV/07-public-list.har" har \
  --record 37 --record 193 --record 196 --record 246 \
  --format json --full-output > "$INV/09-list-har-evidence.json"
rea inspect-web-network-capture "$INV/13-public-watchlist.har" har \
  --record 0 --record 273 --record 562 \
  --format json --full-output > "$INV/15-watchlist-har-evidence.json"
rea inspect-web-network-capture "$INV/21-api-film.har" har \
  --record 0 --record 165 --record 480 \
  --format json --full-output > "$INV/23-api-film-har-evidence.json"
rea inspect-web-network-capture "$INV/28-detail-directory-auth.har" har \
  --record 0 --record 183 --record 436 \
  --format json --full-output > "$INV/30-detail-directory-auth-har-evidence.json"

bun "$INV/summarize-evidence.cjs"
```

Les sorties CDP complètes ont également été redirigées vers les fichiers privés du tableau. Les commandes navigateur de capture ont utilisé `network har start`, puis `network har stop <chemin privé>`. Les lectures du DOM ont sélectionné des attributs de films et des éléments de navigation ; aucune lecture de cookies ou de stockage de connexion n'a été demandée.
