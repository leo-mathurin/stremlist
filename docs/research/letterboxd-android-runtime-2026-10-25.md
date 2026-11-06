# Letterboxd : observation de l'Android physique

Date : 25 octobre 2026. L'utilisateur a autorisé l'accès à son téléphone et à
son compte Letterboxd. Les commandes sont exécutées sur le Mac via le Grant
Mac Access, avec REA CLI 6.7.0 et ADB 36.0.0. Les données brutes restent hors
du dépôt.

## Résultats

- Le téléphone détecté est un Huawei MAR-LX1A sous Android 10, relié en USB.
- Le paquet installé est `com.letterboxd.letterboxd`, version 3.6.4, code 510.
  L'installateur déclaré est `com.android.vending`.
- L'écran des réglages affiche `Signed in as lelemathrin` et une action
  `Sign out`. Cette action n'a pas été activée.
- La watchlist affiche quatre films : The Devil All the Time, Once Upon a
  Time... in Hollywood, American History X et Captain Fantastic. La page
  publique du même compte contient les quatre mêmes titres, sans session web
  connectée. Cette concordance porte sur cette collection de quatre films.
- L'onglet Lists affiche `No lists.`. Aucun cas réel de liste privée n'est
  donc disponible sur ce compte pour cette observation.
- Un relais CONNECT local observe une connexion à `api.letterboxd.com:443`
  pendant le redémarrage de l'application et un geste de rafraîchissement.
  Il relaie le TLS chiffré, sans terminer la session TLS.

Le résultat réseau confirme le serveur contacté, pas les URL complètes, les
en-têtes OAuth ou le contenu des réponses. Le code statique doit être cité
séparément pour ces éléments. Une connexion CONNECT peut transporter plusieurs
requêtes HTTP ; elle ne représente pas un décompte de requêtes API.

## Origine et identité de l'APK

REA `pull-adb-package` a récupéré l'APK principal et les trois APK de
configuration installés. Les quatre empreintes ont été revérifiées après
transfert du Mac vers la tour.

| Fichier | Taille en octets | SHA-256 |
| --- | ---: | --- |
| `base.apk` | 154190863 | `7cc023baebc4a22582ff7720907d20790919f6897cc65522a4e8e0a7c594b89b` |
| `split_config.arm64_v8a.apk` | 19440820 | `2be3ba44eac16201a2b93a620e379e567fdaf80f44125b62f1b385dd131e5754` |
| `split_config.en.apk` | 172242 | `969dea1344d253544fe3c463edd3c5d7892b90e1f76511d619dd6247eae56bb5` |
| `split_config.xxhdpi.apk` | 5876265 | `1304f8b3aa7a4409977c9b57ff3fabb3757f2b8dcb5b6643f02266307184d837` |

Une vérification supplémentaire, réalisée avec `apksigner` et non avec REA,
valide la signature APK v3 du fichier principal. Le certificat déclare
`CN=Letterboxd, OU=Letterboxd, O=Letterboxd, L=Auckland, ST=Auckland, C=NZ`.
Son empreinte SHA-256 est
`4ea9e60e751370c1ccd6d1c191964c8340a891cbbfcc2da1568b84313b9a4e74`.
La vérification du certificat et l'installateur déclaré ne constituent pas
une attestation matérielle du téléphone ou de son historique.

## Parcours effectué

1. Découverte du téléphone et recherche du paquet avec REA.
2. Relevé de la version et récupération de l'ensemble installé avec REA.
3. Ouverture de Letterboxd avec `start-adb-app`.
4. Découverte de la hiérarchie d'accessibilité avec `uiautomator`, puis
   sélection de Watchlist et Lists à partir des limites des éléments découverts.
5. Lecture des réglages pour confirmer la connexion, puis retour sans sauvegarde.
6. Observation réseau bornée, avec un redémarrage de Letterboxd et un geste
   de rafraîchissement dérivé des limites du conteneur découvert.
7. Vérification du rétablissement réseau et retour à l'onglet Diary, qui était
   visible au début. Suppression du fichier XML temporaire créé sur le téléphone.

Argent n'est pas disponible dans cette session. Les observations de hiérarchie
et les gestes sont donc réalisés avec ADB ; aucune coordonnée n'est déduite
d'une capture d'écran. Les captures d'écran et les relevés d'identité utilisent
REA. Aucun simulateur, serveur Argent ou émulateur n'a été démarré.

## Observation réseau

Le producteur est un petit relais Python exécuté sur le Mac. Il écoute sur une
adresse de boucle locale, reçoit une redirection ADB temporaire et ouvre des
tunnels CONNECT vers le serveur demandé. Les octets TLS sont transférés sans
être conservés. Seules les métadonnées des domaines Letterboxd sont retenues.

Fenêtre retenue : 23:09:08 à 23:09:48 UTC. Le relais a observé un tunnel vers
`api.letterboxd.com:443`, avec 2 885 octets du client et 67 146 octets du serveur.
Ces compteurs comprennent le protocole TLS et peuvent regrouper plusieurs
requêtes. Ils ne donnent ni taille des réponses JSON, ni quota, ni débit de
production. Le marqueur `CancelledError` du tunnel correspond à son arrêt
contrôlé lors du nettoyage.

Le réglage historique `http_proxy` valait `null` avant l'essai. À la fin,
il vaut de nouveau `null`, et la liste des redirections ADB est vide.
Ces deux lectures étaient insuffisantes : le 26 octobre, les clés effectives
`global_http_proxy_host` et `global_http_proxy_port` révèlent encore le relais
arrêté. Le booléen `proxy_restored` de l'ancienne preuve ne validait que la clé
historique et ne doit pas être utilisé comme preuve du rétablissement réel.
Le proxy effectif a depuis été retiré et le fonctionnement réseau de l'app
revérifié ; voir [la correction et les essais privés](letterboxd-private-lists-2026-10-26.md).
Aucun certificat n'a été installé sur le téléphone.

Une première exécution du relais a attendu indéfiniment la fermeture de
connexions après avoir déjà rétabli le proxy et retiré la redirection. Elle
ne fournit aucune mesure retenue. Son processus identifié a été arrêté et
l'ordre de fermeture corrigé avant la fenêtre ci-dessus. Le fichier source
de la seconde exécution est archivé dans
`phone_https_relay.observed-20261025.py.txt`, avec l'empreinte
`a042c0af1707e1225f04acb9fde9b4719600cfcee771f8ba97735b5bc47b214f`.

## Limites de l'observation

`run-as com.letterboxd.letterboxd id` répond que le paquet n'est pas débogable.
ADB s'exécute comme utilisateur `shell`, et `command -v su` ne trouve pas de
binaire. Ce dernier test ne prouve pas à lui seul l'absence de toute possibilité
de privilèges. Aucun déverrouillage, changement de signature, accès root ou
remplacement de l'application n'a été tenté.

Un relevé Logcat limité au PID de Letterboxd a été enregistré avec REA. Il ne
contient aucune URL HTTP/HTTPS dans l'échantillon retenu et ne révèle pas les
requêtes API. L'état de connexion est observé dans l'interface, sans extraction
de jeton, mot de passe ou fichier de session.

Au terme de cette première phase, restent non vérifiés : contenu exact des réponses API, remplissage réel des
liens IMDb/TMDB dans une réponse de liste, renouvellement effectif du jeton,
lecture de listes privées et opérations d'écriture. Aucune note, liste ou
entrée de watchlist n'a été modifiée pour cette investigation. La capacité de
Letterboxd à accepter des dizaines de milliers de comptes Stremlist n'a pas
été mesurée.

Le [complément du 26 octobre](letterboxd-private-lists-2026-10-26.md) valide
ensuite la création et la lecture de deux listes privées, avec les limites
propres à ces nouveaux essais. Les déclarations d'absence de mutation ci-dessus
décrivent la phase du 25 octobre.

## Preuves

Les fichiers sont dans
`~/.local/share/rea/investigations/letterboxd-20261025/` sur la tour, avec des
originaux sur le Mac. Les copies des sorties Mac sont préfixées `mac-`.

| Observation REA | Evidence ID |
| --- | --- |
| Téléphone physique | `ev_2765554f21124b46e21f6864261b69625c12b8a4d28f8da63962447d069fee85` |
| Propriétés Android | `ev_37288395f4bb136ec94f83637104aa37d98c0da8b41cb2cfd5787b13efd66a45` |
| Paquet installé | `ev_0a3ed0dd5b3da10d0e471f889f1331b2ec3b3d0a0ee15dc0b06f3f937bda6cb5` |
| Ensemble des APK récupérés | `ev_1c913b044afc05b0bbc0963c16b1a3cb6acbd1b2888b5828f11e6aaa358eb953` |
| Capture de la watchlist | `ev_55b89021109e7f07c75a79c3dc0a91783aa0f50e7c64f19c5e17b6386d6697be` |
| Capture de l'onglet Lists vide | `ev_1c9b18abd04a6efcd95ce9b75f1d2d8cca956873111c6effd9c3419f2376fed5` |
| Logcat du processus | `ev_676efd21aef16483c9a8db3e3d8ef5c44f4c0f6b99867770597ba0d3283d1db2` |
| Redémarrage avant capture, arrêt | `ev_8d64f2148f3dce84109a4c914d328c87a64297f03c43c6e384aae865ade44d26` |
| Redémarrage avant capture, lancement | `ev_e9e2da7a545e1722c8a834c4ea7f6d14cae901a50281f4d365dce1074f9ea418` |
| Même watchlist dans le navigateur public | `ev_5aa538aac3deb787074bede07dd102d60bb4f026d12c68c73ec3b29750db89aa` |

Les fichiers suivants sont des observations ADB ou du relais Python, et non
des sorties REA :

| Fichier | SHA-256 |
| --- | --- |
| `mac-ui-settings.xml` | `e45285496a13bbf9d2d42d8bacaf7f482982871ec847477defc5b69e1f282786` |
| `mac-ui-watchlist.xml` | `10ec770ea7a4c4e9b9ebd111dae13a5f9fe108233325bec8e44f1c22a7161278` |
| `mac-ui-lists.xml` | `f3b31598a7e2422eb75c9626ea0b555b26686c429ae58b1f25c67700cb4f103d` |
| `mac-https-relay-metadata.json` | `e00a428c743b0f21349ce8a5822a2498402dfd54f4626d79ed13bcb74a7b2f70` |

## Commandes REA principales

`SERIAL` représente l'identifiant retourné par la découverte du téléphone.
`OUT` est le répertoire privé sélectionné pour les preuves.

```sh
rea list-adb-devices --format json --full-output
rea inspect-adb-device "$SERIAL" --format json --full-output
rea resolve-adb-packages "$SERIAL" letterboxd --format json --full-output
rea inspect-adb-package "$SERIAL" com.letterboxd.letterboxd --format json --full-output
rea pull-adb-package "$SERIAL" com.letterboxd.letterboxd \
  --output-directory "$OUT/apks" --format json --full-output
rea start-adb-app "$SERIAL" com.letterboxd.letterboxd --format json --full-output
rea capture-adb-screen "$SERIAL" --output-directory "$OUT/screens/watchlist" \
  --format json --full-output
rea read-adb-logcat "$SERIAL" --pid "$LETTERBOXD_PID" --count 300 \
  --format json --full-output
```
