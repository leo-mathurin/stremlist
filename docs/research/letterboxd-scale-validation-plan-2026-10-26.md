# Choisir l'accès Letterboxd pour Stremlist

Date : 26 octobre 2026. Ce document propose les prochaines validations. Il ne
rapporte aucun nouveau déploiement, pilote ou test de charge.

## Décision à obtenir

Choisir un mécanisme dont on peut vérifier la connexion utilisateur, la lecture
complète, les reprises et le coût. Un nombre de comptes inscrits ne définit
pas le trafic : il faut compter les collections distinctes actives, leur taille
et leur cadence de mise à jour.

Les [essais existants](letterboxd-investigation-2026-10-25.md) prouvent la
lecture HTML publique depuis la tour et la lecture privée avec la session du
propriétaire dans un navigateur. Ils ne prouvent pas encore l'authentification
d'un client API indépendant, la portabilité d'une session vers le backend,
son maintien ou la capacité acceptée par Letterboxd.

## Trois pistes à qualifier

### HTML public depuis l'hébergement réel

Le prototype doit effectuer un import complet depuis l'environnement de
Stremlist, sur quelques collections autorisées, puis reprendre après erreur.
Comparer le Worker et un petit service d'import si l'exécution hors Worker
répond à un problème réellement observé. Une réponse HTTP 200 dans Chrome ou
Bun sur la tour ne prouve pas le même accès depuis ces environnements.

Mesurer les pages effectivement reçues, leurs entrées, les conversions IMDb,
la latence et les erreurs. Garder les résultats du même corpus et des mêmes
paramètres. Un changement de lieu d'exécution sert à comparer les contraintes
des hébergements, pas à transformer un refus en boucle de tentatives.

### HTML privé avec une connexion utilisable par les utilisateurs

Le test crucial commence par le parcours de connexion et se poursuit après un
redémarrage du processus. La connexion personnelle via Bitwarden utilisée pour
l'investigation n'est pas un parcours de connexion livré à Stremlist.

Vérifier comment un utilisateur donne accès à ses collections, comment la
session est conservée, comment il peut la retirer, et ce qui arrive après son
expiration. Une réauthentification doit être signalée sans vider le dernier
catalogue valide. Deux utilisateurs doivent garder des données séparées.

Une synchronisation assistée par une extension est une variante à étudier si
le produit accepte sa contrainte d'installation et une fraîcheur liée à
l'activité du navigateur. Un content script peut lire une page et transmettre
les données à son extension, selon la [documentation Chrome](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts).
Cela ne démontre ni une synchronisation permanente ni une compatibilité avec
tous les appareils. Le [cycle de vie des workers d'extension](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
doit être pris en compte. Aucune extension n'a été construite ou testée ici.

### API native hors de l'application

L'APK fournit les routes, modèles et mécanismes OAuth, mais aucune requête API
authentifiée n'a été émise depuis un client indépendant dans nos essais.
Un prototype doit identifier explicitement le client qui porte l'accès, les
champs reçus, la pagination complète et le renouvellement réellement obtenu.
Un succès sur le compte de Léo ne prouverait pas le quota d'un service partagé.

Les identifiants embarqués désignent le client Android officiel. Une solution
qui en dépend reste liée aux changements de ce client. La
[documentation Letterboxd](https://api-docs.letterboxd.com/) distingue le flux
Password réservé au client officiel du flux Authorization Code pour un client
tiers authentifié. L'[accès officiel](https://letterboxd.com/api-beta/) se
demande toujours séparément. Poursuivre cette demande en parallèle avec un
besoin chiffré : lecture seule, consentement utilisateur, collections visées,
volumes et fraîcheur proposée. Aucun message n'est envoyé par ce plan.

## Banc de validation commun

Réutiliser le contrat de Provider et les mécanismes existants de Stremlist :
correspondance IMDb commune, cache des catalogues, suivi des synchronisations
complètes, isolation des données privées et coordination des renouvellements.
Voir [l'architecture actuelle](../architecture.md). L'adaptateur Letterboxd
reste actuellement indisponible dans le produit.

Le corpus doit comprendre une collection vide, une petite collection et une
collection qui dépasse plusieurs pages, en public et en privé lorsque l'accès
le permet. La liste privée de deux films ne valide pas la pagination.

Chaque candidat doit réussir les contrôles suivants :

- importer toutes les pages avec l'ordre et les identifiants attendus ;
- détecter un ajout et un retrait sur les listes de test ;
- distinguer une liste vide valide d'un accès refusé ou d'une lecture partielle ;
- conserver le dernier résultat complet en cas de panne ou de session expirée ;
- reprendre sans doublon après interruption et éviter les renouvellements concurrents ;
- ne jamais réutiliser une collection privée pour un autre utilisateur ;
- compter les erreurs, les tentatives et le travail réellement effectué, avec
  des caches froids puis chauds.

Commencer ensuite un petit pilote avec des comptes volontaires, pendant
plusieurs jours. Compléter cette observation par des cas explicites
d'expiration, de déconnexion et de reconnexion sur les sessions de test : une
semaine sans incident ne prouve pas la durée complète d'une session. Le taux
de réussite doit préciser son dénominateur et le nombre de lectures complètes.

## Mesurer le volume avant de choisir la cadence

Pour une collection distincte par compte actif :

```text
requêtes de pages par jour = comptes actifs × ceil(films / taille de page) × imports complets par jour
```

Exemples théoriques, calculés avec 50 000 comptes actifs et 500 films chacun :

- à 100 films par page et quatre imports par jour : 1 000 000 requêtes/jour,
  soit 11,57 requêtes/seconde en moyenne ;
- à 28 films par page et quatre imports par jour : 3 600 000 requêtes/jour,
  soit 41,67 requêtes/seconde en moyenne ;
- à 100 films par page et un import par jour : 250 000 requêtes/jour.

Les tailles de 28 et 100 correspondent à des vues différentes déjà observées ;
elles ne sont pas interchangeables ni garanties pour toutes les ressources.
Les tailles de collection et cadences ci-dessus sont des hypothèses, pas une
moyenne mesurée ni une promesse de fraîcheur. Les calculs excluent la découverte
des listes, l'authentification, les conversions IMDb manquantes, les reprises,
les ressources d'un navigateur et les pointes de trafic. Ils ne prouvent pas
que Letterboxd accepte ces débits.

Mutualiser les listes publiques identiques et les correspondances de films.
Mettre à jour prioritairement les collections effectivement utilisées, et
étaler leurs imports. Réutiliser les catalogues enregistrés pour servir
Stremio ; une ouverture de catalogue ne doit pas provoquer une lecture de
Letterboxd pour chaque utilisateur.

Pour des travaux différés, [Cloudflare Queues](https://developers.cloudflare.com/queues/)
peut porter les imports avec délai et reprise si ce besoin est confirmé.
Ce choix d'infrastructure ne règle pas l'accès au service source.

## Vérifier notre capacité et décider

Simuler progressivement 1 000, 10 000 puis 50 000 comptes sur notre
infrastructure, avec un fournisseur factice fondé sur le corpus. Mesurer les
files, le cache, les accès au stockage, les erreurs et les coûts, puis vérifier
la cohérence des sorties. Ces essais mesurent Stremlist, pas les quotas de
Letterboxd. Les accès réels restent ceux du petit pilote, avec les conditions
du mode d'accès retenu.

Avant le pilote, choisir les objectifs de fraîcheur, de délai d'import, de
budget par millier d'utilisateurs et de taux d'échec accepté. Un transport est
retenu seulement si le parcours de connexion fonctionne pour les utilisateurs
cibles, si les imports restent complets et si les mesures correspondent au
budget et à la fraîcheur annoncés. Publier le privé et les actions uniquement
avec les capacités effectivement validées.

## Ordre recommandé

1. Construire le banc d'import et qualifier le HTML public depuis l'hébergement
   réel, en réutilisant l'infrastructure existante.
2. Qualifier le parcours de connexion privé et le maintien de session ; garder
   l'API native comme candidat technique distinct tant que l'authentification
   hors application et ses conditions ne sont pas démontrées.
3. Faire le pilote et calculer le volume réel par utilisateur actif.
4. Vérifier la capacité de Stremlist par simulation, puis choisir le périmètre
   à lancer d'après les résultats. Poursuivre en parallèle la demande d'accès API.
