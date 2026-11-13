# Letterboxd : essais sur deux listes privées

Date : 26 octobre 2026. L'utilisateur a explicitement demandé de créer des
listes privées et de les tester. Deux listes de test ont été créées sur son
compte `lelemathrin`, avec la visibilité **You (private list)** avant la
sauvegarde. Elles restent privées sur le compte pour les essais suivants.

## Résultat

La lecture des deux listes fonctionne avec la session web du propriétaire et
dans l'application Android connectée. Les mêmes URL renvoient HTTP 404 sans
session. L'annuaire public ne révèle ni leur nom ni leur contenu.

Ce résultat établit une possibilité de lecture privée par le HTML avec une
session utilisateur authentifiée. Il ne constitue ni une connexion OAuth
Stremlist, ni une mesure de stabilité des sessions, de quotas ou de capacité
pour des dizaines de milliers d'utilisateurs.

## Listes créées

| Liste                                                                                                             | LID observé | Contenu final                                            |
| ----------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------- |
| [Stremlist test prive 20261026](https://letterboxd.com/lelemathrin/list/stremlist-test-prive-20261026/)           | `YdCpg`     | Captain Fantastic (2016), puis American History X (1998) |
| [Stremlist test prive vide 20261026](https://letterboxd.com/lelemathrin/list/stremlist-test-prive-vide-20261026/) | `YdCxa`     | Aucun film                                               |

Les LID proviennent de l'en-tête `x-letterboxd-identifier` des réponses
authentifiées aux pages des listes. L'ordre des deux films est conservé dans
le HTML observé. Leurs identifiants sont respectivement `film:263215` / `b2K2`
et `film:51977` / `2bdo`, dans l'espace de noms Letterboxd.

## Vérifications réalisées

| Parcours                                             | Liste de deux films                       | Liste vide                              |
| ---------------------------------------------------- | ----------------------------------------- | --------------------------------------- |
| Création web, visibilité avant sauvegarde            | You (private list)                        | You (private list)                      |
| Relecture de la page avec la session du propriétaire | HTTP 200, deux cartes et marqueur privé   | HTTP 200, zéro carte et marqueur privé  |
| Annuaire web connecté                                | Liste et lien présents                    | Liste et lien présents                  |
| Android après redémarrage de l'application           | Écran Private list, deux titres attendus  | Écran Private list, aucun titre de film |
| Annuaire Android                                     | Deux films, icône de politique de partage | No films, icône de politique de partage |
| GET Bun sans session vers l'URL exacte               | HTTP 404, aucune carte ni titre de test   | HTTP 404, aucune carte ni titre de test |

L'annuaire `https://letterboxd.com/lelemathrin/lists/` renvoie HTTP 200 sans
session, mais ne contient aucune des deux listes de test. Les réponses
anonymes ne comportent aucun des marqueurs de challenge recherchés.

Les deux listes ont été créées dans le navigateur connecté, puis découvertes
sur le téléphone après redémarrage de Letterboxd. Cette relecture entre deux
clients confirme la persistance serveur ; elle ne repose pas sur le seul
état local du formulaire de création. Une tentative initiale dans un formulaire
Android n'a pas été conservée et n'est pas comptée comme une troisième liste.

Le compte web a été connecté par le parcours Bitwarden habituel, après son
approbation. Aucun mot de passe, cookie ou jeton n'a été affiché ou copié dans
les rapports. Les lectures web utilisent `fetch` dans la page déjà connectée,
avec les cookies gérés par le navigateur. Les essais anonymes utilisent un
processus Bun distinct, sans fournir de session.

## Conséquences pour Stremlist

1. **Le HTML privé est lisible avec une session du propriétaire.** Les cartes
   et leur ordre sont présents dans les réponses HTML de ces deux cas. Le
   navigateur fournit une voie de lecture démontrée, distincte du flux OAuth
   de l'application Android.
2. **Un extracteur anonyme ne suffit pas pour le privé.** Connaître l'URL ou
   le LID ne rend pas la liste accessible. Un HTTP 404 ne doit pas être traité
   automatiquement comme une collection valide vide : la liste vide autorisée
   répond ici HTTP 200, tandis qu'un accès anonyme refusé répond HTTP 404.
3. **La connexion des utilisateurs reste à concevoir et valider.** Ces essais
   ne fournissent pas un client OAuth à Stremlist et ne mesurent pas la durée
   de session, le renouvellement, la révocation ou l'accès depuis les Workers.
   La bibliothèque publique `letterboxdpy` n'a pas été testée avec une session
   connectée dans ce complément.

La création et la lecture de ces seules listes sont validées. Les notes de
films, l'ajout ou le retrait dans la watchlist et la suppression de listes
existantes n'ont pas été testés. Les quatre films de la watchlist initiale
n'ont pas été modifiés. Aucun appel API réutilisant les identifiants du client
officiel Android n'a été effectué. Le contenu des réponses HTTPS natives
reste non déchiffré.

## Correction du nettoyage réseau précédent

Une erreur du relais d'observation du 25 octobre a été identifiée pendant ces
essais. Supprimer la clé historique `http_proxy` ne suffisait pas sur ce
téléphone : `global_http_proxy_host` conservait `127.0.0.1` et
`global_http_proxy_port` conservait le port du relais arrêté. Le premier
rapport avait donc conclu trop tôt au rétablissement du réseau.

Le proxy effectif a été désactivé en appliquant `http_proxy=:0`, puis en
supprimant la clé historique. Les lectures suivantes confirment un hôte vide,
un port `0`, une URL PAC vide et aucune redirection ADB. La recherche de films
a de nouveau renvoyé ses résultats, puis les deux nouvelles listes ont été
chargées sur le téléphone. Ces contrôles de fonctionnement complètent la
lecture des réglages.

Le helper local de relais a été corrigé : il contrôle désormais les clés
effectives, refuse d'écraser un proxy déjà configuré et conserve leur état
avant son essai. Sa syntaxe a été contrôlée, sans relancer un essai de proxy.
Le source exact de l'observation précédente est archivé séparément comme
trace documentaire. Les listes sont laissées visibles dans l'application et
le fichier XML temporaire créé sur le téléphone est supprimé.

## Preuves

Répertoire privé sur la tour :
`~/.local/share/rea/investigations/letterboxd-20261025/private-lists/`.
Les originaux des observations Android sont sur le Mac et leur copie locale
est dans `phone/`. Les identifiants de connexion ne figurent pas dans ces
rapports ; les données brutes ne sont pas destinées à un PR.

| Preuve REA                                            | Evidence ID                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| Page privée de deux films dans le navigateur connecté | `ev_9e1ce85d72ea3d347557a97b32e0e02a050cd9b14f23818e63321f3f9ae6b546` |
| Page privée vide dans le navigateur connecté          | `ev_3622eaef178a6d1fc4d6287c690f84ba49345c5a00cc58566b67959127111a47` |
| Annuaire des deux listes sur le téléphone             | `ev_d7884b42ee0b61aa3f188517442ded7df5224aafe2d9871a6612af5bb934b4ba` |
| Liste privée de deux films sur le téléphone           | `ev_9b7cb7faeebaea03459212ff446a237f7112abe4080a4d9be4d7a96ef079a222` |
| Liste privée vide sur le téléphone                    | `ev_bc263bc5891cbb42f32c69d5bdbb4f865b560e828071a6e55bd0e49d96e6d852` |

`authenticated-results.json` conserve les statuts, LID et cartes obtenus par
les lectures du navigateur. `anonymous-results.json` et les trois fichiers
`anonymous-N.html` conservent les essais Bun sans session. Ce sont des
observations du navigateur et de Bun, et non des sorties REA. Les XML de
hiérarchie et `effective-proxy-cleanup.json` sont des observations ADB,
également distinctes de REA. Un manifeste local conserve les SHA-256 des
fichiers de ce complément.

Seule la documentation du dépôt a été modifiée. Aucun comportement de
Stremlist n'a changé et aucun commit n'a été créé.
