# Assistant commercial v5

## Périmètre

Interface v5 et serveur autonome `D:/works/magileads-ai-server`. Administration, facturation et gestion des accès hors périmètre, conformément au choix utilisateur.

Le serveur conserve les outils de lecture/ciblage existants et ajoute un catalogue explicite de 110 opérations commerciales, consulté avec `discover_operations` puis exécuté avec `run_operation`. Les imports et uploads passent par `open_commercial_form` ; la connexion email utilise `connect_email`. Les formulaires prennent le relais du chat. Ce n’est pas un proxy arbitraire vers toutes les routes de l’API.

## Comportement

### PRM : colonnes et comptages exacts

La bulle PRM transmet uniquement sur le dernier message le propriétaire du
tableau ouvert, ses colonnes visibles et son filtre courant :

```text
[Screen context from the app, not written by the user]
PRM context: {"user_id":391,"owner_name":"Iris","columns":[{"key":"9220","name":"My column","system":false}],"exclude_custom":true,"filter":null}
```

Les permissions et les propriétaires accessibles sont toujours revérifiés via
le jeton Magileads de l'appelant et `/prm/list`. Le contexte de page ne donne
aucun droit supplémentaire. Un PRM partagé ne doit jamais utiliser les colonnes
personnalisées de l'opérateur : elles viennent du propriétaire dans `/prm/list`,
si elles y sont exposées. Sinon, l'outil signale la limite.

Quatre outils de lecture sont disponibles :

```ts
list_prm_pipelines({});
list_prm_statuses({ user_id?: number });
count_prm_contacts({
  user_id?: number;           // PRM ouvert, sinon compte connecté
  column?: string;           // nom réel, résolu et vérifié côté serveur
  custom_status?: number;    // ID réel de colonne personnalisée
  status?: string;           // code système réel
  filter?: PrmFilter;
  entire_prm?: boolean;      // ignorer le filtre de page si explicitement demandé
});
query_prm_contacts({
  // mêmes champs que count_prm_contacts
  search?: string;           // any_datafield contains, au moins 3 caractères
  limit?: number;            // défaut 10, maximum 25
  next_page?: string;        // curseur Magileads, même origine et même propriétaire
});
```

`PrmFilter` est un groupe `{mode:"and"|"or", values:[...]}` de conditions
`{field_name:string,type:string,value:string}` ou de groupes imbriqués.
Les champs admis sont `any_datafield`, `status`, `custom_status`, `is_positive`,
`new_reply`, `new_first_reply`, `in_active_programmation`, `score`,
`person_in_charge`, `tag_id`, `created_on`, `status_changed_date`,
`last_reply_or_status_changed_date`, `last_call`, `programmation_id`,
`workflow_id`, `contact_list_id`, `id`. Les identifiants numériques des champs
de listes de contacts ne conviennent pas au PRM. Les trois indicateurs
`new_reply`, `new_first_reply`, `in_active_programmation` prennent `equals` avec
`"1"` ou `"0"`. Les opérateurs sont `equals`, `not_equals`, `contains`,
`not_contains`, `does_exist`, `does_not_exist`, `more_than`,
`more_or_equal_than`, `less_than`, `less_or_equal_than`.

Pour une colonne personnalisée, le filtre utilise `custom_status equals ID`.
Pour une colonne système, il utilise `status equals CODE` et exclut les contacts
déjà classés dans une colonne personnalisée lorsque le tableau le fait aussi.
Les filtres de page et les critères demandés sont joints en AND en préservant
les groupes OR. Une colonne inconnue ou ambiguë est refusée avant de lire des
prospects ; aucun comptage global de remplacement.

`count_prm_contacts` appelle `GET /prm/contacts/user/{user_id}` avec
`options={per_page:1,filter:...}` et renvoie :

```ts
{
  user_id: number; owner_name: string;
  column: {key:string,system:boolean,name:string} | null;
  filter: PrmFilter | null; count: number;
}
```

`count` est le `number_of_results` filtré, jamais la longueur de `results`.
Zéro reste zéro ; un total absent produit une erreur. La réponse utilisateur
est une phrase avec le nombre et le nom de colonne. Aucun détail de prospect
n'est transmis au modèle pour un comptage. La lecture nominative n'est utilisée
que si elle est demandée et sépare explicitement total et échantillon.
Ces outils ne produisent ni `assistant.card` ni `assistant.changed` et ne font
aucune mutation. Le front masque aussi les anciennes cartes `kind:"leads"`.

Vérifié le 5 octobre 2026 : schémas du Swagger déployé, tests d'outils
(comptage supérieur à 25, zéro, ambiguïté, propriétaires partagés, filtres,
pagination, permissions) et flux HTTP/SSE avec API et modèle simulés.
Une conversation réelle depuis la bulle locale, avec DeepSeek Pro et l'API
Magileads de production, a retourné les totaux du PRM d'Iris RAS : `test = 2`,
`Openers = 261`, `Positives d = 0`, identiques au tableau, sans carte de
prospect. Une lecture nominative explicitement demandée des deux prospects de
`test` a aussi retourné les deux noms exacts, en texte sans carte. Aucune
opération d'écriture n'a été demandée. Le serveur IA corrigé
était local, pas encore déployé ; les PRM partagés, filtres imbriqués et curseurs
ont été testés avec fixtures, pas avec une interrogation client réelle.

### Réponses orientées utilisateur

Les consignes du modèle distinguent ses opérations internes de la réponse
affichée. Un audit commence par les résultats de la campagne et les actions
conseillées ; il ne cite pas les noms d’outils, les endpoints, les identifiants
internes de workflow ou le filtrage technique de certaines mesures. Une limite
n’est mentionnée que si elle change la conclusion demandée, en termes métier.
Les chiffres restent vérifiés ; un taux n’est pas comparé à une moyenne externe
sans objectif ou référence chiffrée vérifiée. Les identifiants de listes et de
campagnes restent disponibles lorsqu’ils servent à choisir ou à ouvrir une
entité, et une explication technique reste possible si elle est demandée.

`examples/audit-tone-model-smoke.mjs` teste cette formulation avec le fournisseur
réel et une campagne entièrement fictive. Il vérifie l’absence de détails
techniques et de comparaison non sourcée ; aucune donnée client n’est lue.

### Cartes de listes uniquement pour choisir

`list_contact_lists` et `get_contact_list` sont des lectures sans carte visible.
Une liste nommée ou indiquée par ID peut être analysée ou utilisée sans imposer
un nouveau choix. Les classements demandés sont présentés en texte/Markdown.
Après une action, la réponse annonce le résultat et peut fournir le lien de liste.

Pour demander un choix (bouton « Choisir une liste », cible manquante ou nom
ambigu), le modèle appelle `ask_contact_list`, puis attend la sélection :

```ts
{
  query?: string;
  sort?: "contacts" | "emails" | "linkedin" | "companies" | "recent" | "name";
  limit?: number; // défaut 50, maximum 50
  page?: number; // défaut 1
}
```

Cet outil lit les mêmes listes réelles du compte que `list_contact_lists`, sans
mutation, et produit uniquement si des listes sont disponibles :

```text
event: assistant.card
data: {"kind":"lists","items":[{"id":69964,"name":"DAF Paris","contacts":36,"emails":19,"linkedin":36}],"total":1,"purpose":"selection"}
```

Le champ `purpose` vaut `"selection"` ou `"created"`. Seules les cartes de
listes avec `purpose:"selection"` sont affichées par v5 ; les anciennes cartes
sans ce champ sont masquées aussi dans l’historique. Les cartes de prospects
PRM sont également masquées ; les autres types restent affichés. Le texte
n’est pas retiré au profit d’une carte masquée.

Les outils de copie et de ciblage conservent le contrat d’import :
`tool.progress` avec `creates_list:true`, puis `assistant.card` avec
`{kind:"lists",items:[{id,name}],purpose:"created"}`. Ce reçu invisible permet
toujours l’écran « Recherche lancée » et son lien vers la liste. Un choix de
liste n’est jamais traité comme une création ; les reçus d’un ancien serveur
sans `purpose` restent reconnus par l’import pendant le déploiement.

Vérifié le 29 septembre 2026 : 72 tests serveur et 36 tests front passent,
y compris l’import et les propositions de suppression. Le smoke fournisseur
réel avec Deepseek Pro et des données Magileads fictives confirme : copie vers
une liste nouvelle/existante et comptage sans sélecteur, classement en tableau,
choix explicite avec un sélecteur. Aucun appel à l’API de données client ;
coût fournisseur du smoke d’environ 0,0362 USD.

### Documents Word, CSV et Excel

L’outil `create_document` prépare une carte téléchargeable, disponible dans
l’assistant complet, la bulle et le mode import. Le navigateur v5 crée le fichier
au clic : aucun fichier, chemin temporaire, upload, dépendance ou stockage `/data`
n’est ajouté au serveur IA. Le contenu structuré reste dans l’historique du
navigateur, rattaché au compte actif ; il peut être repris au tour suivant pour
modifier le document. Aucun endpoint ni paramètre de connexion supplémentaire.

Arguments de l’outil (champs facultatifs marqués `?`) :

```ts
{
  format: "docx" | "csv" | "xlsx";
  title: string;
  filename?: string;
  sections: Array<{
    heading?: string;
    paragraphs?: string[];
    table?: {
      columns: string[];
      rows: Array<Array<string | number | boolean | null>>;
    };
  }>;
}
```

- Word : au moins une section avec des paragraphes non vides ou un tableau.
  Titres, paragraphes et tableaux natifs ; les grandes tables passent en paysage.
- CSV : exactement une section et un tableau, sans paragraphes. UTF-8 avec BOM,
  séparateur `;`, fins de lignes CRLF. Les chaînes susceptibles de devenir des
  formules sont préfixées par une apostrophe ; les valeurs numériques restent
  numériques. Les couleurs ne font pas partie de ce format.
- Excel : un tableau par section, une feuille par section, sans paragraphes.
  Format `.xlsx` (pas l’ancien `.xls`), noms de feuilles uniques, première ligne
  figée, filtre et entêtes aux couleurs du revendeur. Les nombres et booléens
  gardent leur type ; les chaînes restent du texte, jamais des formules.
- Une ligne a exactement autant de cellules que de colonnes ; `null` produit
  une cellule vide, jamais un zéro inventé. Limites intrinsèques Excel : 16 384
  colonnes, 1 048 575 lignes de données plus l’entête, 32 767 caractères par
  cellule (entêtes inclus). Les téléphones/codes postaux sont transmis en texte.
- Les formats et dimensions invalides échouent sans carte. Les noms de fichiers
  sont nettoyés et leur extension imposée. Les propriétés inconnues, secrets et
  diagnostics exclus sont retirés ; les colonnes/lignes exclues sont retirées
  ensemble pour préserver l’alignement des données.

Résultat de l’outil : `{status:"document_ready", document:{format,title,filename,sections}}`.
Le serveur transmet ce même document au front via le contrat SSE existant :

```text
event: tool.progress
data: {"tool":"create_document","label":"Préparation du document","status":"running","creates_list":false}

event: tool.progress
data: {"tool":"create_document","label":"Préparation du document","status":"completed","creates_list":false}

event: assistant.card
data: {"kind":"document","document":{"format":"xlsx","title":"Matrice","filename":"Matrice.xlsx","sections":[{"heading":"Contacts","table":{"columns":["Métier","Localisation du contact","Contacts"],"rows":[["Marketing / CMO","Île-de-France",24],["Juridique / légal","Germany",null]]}}]}}
```

`changesData` est faux et aucun `assistant.changed` ni lancement de liste n’est
émis. Le contenu de la carte n’est pas tronqué par la limite générique des
résultats d’outils : le téléchargement doit contenir le document entier.
Le message `tool` renvoyé au modèle ne contient que le reçu (format, titre,
fichier, nombre de sections/lignes) ; cela évite d’y répéter le document entier.
Les limites de requête et du fournisseur restent celles déjà configurées.

Word et Excel utilisent le nom et les couleurs du revendeur résolus par le front,
jamais une marque inventée par le modèle. Aucun code, macro ou ressource externe
n’est inclus dans ces fichiers. Les documents peuvent porter sur le sujet
demandé par l’utilisateur, même hors Magileads. Le modèle ne doit jamais prétendre avoir créé
un fichier avec un tableau Markdown ou un lien inventé.

Validation : `node --test src/documents*.test.js` couvre les trois formats, la
validation/sanitation, les contenus de plus de 12 000 caractères, l’absence
d’appel API/mutation et le flux SSE réel avec modèle/API simulés. Le front teste
la lecture des ZIP Word et des classeurs Excel avec le lecteur SheetJS déjà
installé, les cellules natives, les couleurs du revendeur, le CSV, les cartes
fragmentées en SSE et la reprise du contenu dans l’historique.

`examples/documents-model-smoke.mjs` vérifie
l’appel réel de `create_document` pour les trois formats, avec deux lignes
fictives et sans aucune API de données Magileads. Variables : `AI_API_KEY`,
`AI_MODEL` et, facultativement, `DOCUMENT_TEST_MODEL`. Le 29 septembre 2026,
les trois formats ont réussi avec `deepseek/deepseek-v4-pro` : deux lignes,
types et critères conservés, coût fournisseur total d’environ 0,0057 USD.
Les packages générés par le front ont aussi été ouverts avec `python-docx`
et `openpyxl`, en vérifiant les CRC ZIP, tous les XML, les tableaux, les valeurs
manquantes, la marque, les couleurs, le filtre et la première ligne figée.
La sortie en production dans une conversation authentifiée reste à vérifier
après déploiement ; ce test réel porte sur le fournisseur et les données fictives.

### Périmètre et budget des demandes

**Tests temporaires sans plafonds :** définir `AI_TEST_UNLIMITED_UNTIL` sur le
serveur IA avec une date future ISO UTC (voir README.md). Jusqu’à cette date,
aucun `max_tokens` n’est envoyé, les messages et l’historique ne sont pas
tronqués, et les plafonds de prompt, coût, prix, campagnes, outils et requêtes
par minute sont désactivés, ainsi que la limite de six tours d’outils et le délai
de 120 secondes par appel modèle. L’analyse continue jusqu’à sa réponse finale
ou l’arrêt de l’utilisateur. La clé OpenRouter de plateforme est utilisée en
priorité, sans précontrôle de plafond quotidien ; les quotas du fournisseur
restent applicables. L’authentification, les validations
d’import et la politique de suppression restent actifs. L’absence ou
l’expiration de la variable rétablit le comportement ci-dessous pour chaque
nouvelle requête. `GET /ai/meta` expose `usageLimitsEnabled` pour le vérifier.
Ce champ décrit la configuration de MagIA ; les clés personnelles restent sans
plafond d’usage applicatif même lorsqu’il vaut `true`.
Il expose aussi `executionLimits` avec `maxToolRounds:null` et
`modelCallTimeoutMs:null` pendant les tests. Un commentaire SSE est envoyé toutes
les 15 secondes pendant l’attente. Hors tests, la limite de six tours déclenche
un dernier appel sans outils pour restituer les résultats et les manques.
En mode test, les résultats JSON des outils ne sont plus tronqués par les seuils
de caractères : listes de modèles, contenu complet, champs et autres résultats
renvoyés par l’API. Les secrets et diagnostics exclus restent retirés.
`executionLimits.toolResultTruncationEnabled` permet de vérifier ce réglage.
La pagination et les tailles de pages de chaque outil ne sont pas modifiées.

Tous les assistants acceptent les questions générales, avec MagIA ou une clé
personnelle : assistant principal, bulle, reporting et import. Le serveur
n’effectue plus de classification de sujet avant la réponse. Le prompt invite
le modèle à répondre directement aux questions générales sans outil Magileads
inutile. L’accès aux données et les actions métier restent limités au compte
authentifié ; les validations d’import et de suppression restent obligatoires.

L’IA incluse (`level=user`, OpenRouter) dispose d’un budget estimé de 0,03 USD par
requête, vérifié à chaque appel : texte, outils et résultats
des outils. Les prix des providers sont plafonnés à 0,25 USD/M en entrée et
1,50 USD/M en sortie par `provider.max_price`, sans frais fixes de requête. Les
réservations prudentes sont remplacées par `usage.cost` si disponible, conservées
sinon. Les paramètres `.env` figurent dans README.md ; aucun stockage de données
ni quota utilisateur persistant n’est ajouté. Le repli gratuit impose des prix
nuls. Douze appels d’outils et trois campagnes en détail maximum sont permis.
Un audit global demande une sélection de une à trois campagnes ou une clé
OpenAI personnelle. Lister les campagnes et lire le reporting global restent
possibles. Les clés personnelles lèvent les limites de
messages, de durée, de tours d’outils et de troncature des résultats. Les
quotas propres au fournisseur et la limite de taille du corps HTTP restent en
vigueur ; les validations d’import et de suppression restent obligatoires.
Claude exige `max_tokens` ; le serveur reprend le maximum annoncé par son
catalogue de modèles quand celui-ci le fournit.

Événements d’erreur ajoutés, avec le contrat existant :

```text
event: assistant.error
data: {"code":"request_budget_exceeded"}
```

Codes actifs : `request_too_broad` (quatrième campagne ou treizième outil pour
l’IA incluse) et `request_budget_exceeded` (prochain appel trop coûteux/contexte
trop grand). `off_topic` et `scope_check_unavailable` ne sont plus émis. Les
traductions front existantes restent compatibles avec un ancien serveur pendant
le déploiement. Les cartes et mutations déjà confirmées restent disponibles
après une interruption.
Les événements existants, dont `targeting.criteria`, `creates_list:true` et la
carte `lists` suivant une extraction, sont conservés.

Tests : `node --test src/*.test.js` couvre les questions générales dans les
contextes assistant, PRM, reporting et import, sans classification ; les limites
de coût et campagnes, le repli gratuit, l’authentification et la confirmation
d’import restent testés. `examples/policy-model-smoke.mjs` vérifie les réponses
générales contre les vrais modèles OpenRouter, sans API métier Magileads. Les
contrats HTTP sont vérifiés avec des services simulés ; aucun import ni audit
massif réel n’est lancé par ces tests.

- Fournisseur du modèle : OpenRouter reste le choix partagé par défaut. Les clés personnelles OpenAI, Claude (`type=claude`), Gemini, DeepSeek et OpenRouter proviennent toutes des intégrations du compte Magileads actif. Le serveur IA vérifie l'identité avec `/users/me`, lit `/external-api-keys` à chaque appel et n'utilise la clé qu'en mémoire pendant cet appel. Il ne dispose d'aucun stockage de clés ou volume `/data`. Les appels avec une clé personnelle peuvent être facturés par le fournisseur.

- L’assistant peut **préparer** une suppression de contacts filtrés depuis la page `/assistant` et la bulle. Le modèle termine par un bloc `[[ACTION]]{"type":"delete_contacts","list_id":42,"filter":{"mode":"and","values":[{"field_name":"7","type":"equals","value":"M."}]}}[[/ACTION]]`. Les deltas SSE transmettent ce bloc intact ; le même composant front v5 vérifie la liste et les champs, calcule un aperçu par l’API, demande confirmation puis effectue lui-même l’action. Sur `/assistant`, la liste doit être désignée ou choisie dans la conversation et vérifiée dans le compte actif ; dans la bulle, elle doit être celle ouverte à l’écran. Une question sans suppression ne doit pas produire de bloc.
- Le serveur IA ne déclenche toujours **aucun DELETE** : ses outils de suppression, `run_operation` et le client API les refusent. Une confirmation textuelle dans `/assistant` n’autorise actuellement aucune suppression côté serveur. La suppression locale d’une conversation reste disponible.
- Connexion Google/Microsoft ou SMTP/IMAP via les composants Expéditeurs existants. Les mots de passe du formulaire ne sont pas transmis à la fonction de chat ni enregistrés dans son historique. OAuth conserve le parcours et les contrôles de marque blanche existants.
- Duplication : POST /contact-lists/{id}/copy, restitution du nouvel ID quand disponible.
- Copie de contacts filtrés : `copy_contacts_to_list`, vers une liste existante ou nouvelle ; le filtre complet est transmis à l’API, sans limiter la copie à l’échantillon de `query_contacts`.
- Dropcontact : seules les connexions de type dropcontact du compte sont proposées. Le modèle reçoit uniquement leur ID et nom. Vérification de la connexion avant lancement. Le résultat indique que le traitement a été accepté, jamais un enrichissement terminé sans preuve.
- Cartes v0 adaptées aux résultats réels : campagnes/KPI, listes/compteurs/actions, prospects, choix Dropcontact et fournisseurs email. Les valeurs absentes s’affichent « — ». Aucune reprise des faux contacts, scores et chiffres du prototype v0.
- ID des listes/campagnes/prospects sélectionnables directement ; workflow_id distingué de l’ID de campagne.
- Filtrage récursif des secrets et des diagnostics exclus avant transmission au modèle : désabonnés, contacts sans email, mauvaises adresses et bounces. Les diagnostics d'étape contenant leur nombre dans `message.replacements` sont retirés en entier. L'historique des anciennes réponses est épuré avant réutilisation ; les anciens textes déjà affichés ne sont pas modifiés.
- Pour `profile.level === "user"`, le palier est Simple côté front et serveur, sans sélecteur. Sur OpenRouter, Simple utilise `AI_MODEL_INCLUDED`, sinon `AI_MODEL`, sinon `deepseek/deepseek-v4-flash`, si la clé `AI_INCLUDED_API_KEY` possède un plafond quotidien de 3 USD au plus et un solde positif ; sinon `AI_MODEL_FREE` est choisi. La même priorité de modèle est appliquée pendant les tests sans plafonds. Compose transmet ces variables au conteneur ; le log de démarrage affiche `included=<modèle>`. Une clé `AI_API_KEY_FREE` distincte est recommandée. L'IA incluse refuse les prompts trop volumineux avant tout appel au modèle (`413 shared_prompt_too_large`) ; une clé OpenAI personnelle reste utilisable. Aucun quota individuel journalier persistant n'est possible sans support de l'API Magileads.
- Invalidation des données en cache après les opérations du serveur. Les pages retrouvent les données fraîches à leur prochaine consultation.

### Confirmation des suppressions de contacts dans le front v5

La carte n’apparaît qu’une fois la réponse terminée. Le front charge la liste et
ses champs réels, puis appelle `GET /contact-lists/{id}/contacts` avec
`options={page:1,per_page:5,filter}` pour afficher le nombre et un échantillon des
contacts concernés. Les valeurs possibles renvoyées par `list_contact_fields`
permettent au modèle d’utiliser les valeurs réellement stockées, par exemple
`M.` pour la civilité Monsieur.

Un filtre vide, un champ inconnu, plusieurs blocs d’action ou un aperçu
indisponible empêchent la suppression. L’utilisateur doit cocher la confirmation
puis cliquer sur le bouton qui indique le nombre de contacts. Un changement
d’aperçu retire cette confirmation. Le front envoie alors un seul
`DELETE /contact-lists/{id}/contacts`, avec exactement le filtre prévisualisé et
`{contact_ids:[],filter,excluded_contact_ids:[]}`. Le double clic est bloqué et un
échec n’est jamais rejoué automatiquement. Le compte, la session et la
proposition sont revérifiés avant l’envoi, y compris après renouvellement du
jeton. Annuler n’envoie aucun DELETE.

Le résultat ou l’annulation reste attaché au message et dans l’historique envoyé
au modèle. Après succès, les requêtes de la liste et de ses contacts sont
invalidées pour recharger les données. Une confirmation écrite dans le chat
ne remplace jamais la confirmation de la carte. Le serveur continue à refuser
les DELETE ; les suppressions de listes entières et d’autres entités ne sont pas
des actions prises en charge par cette carte.

Vérification : `node --test src/contact-actions-http.test.js` exerce le flux SSE
et le refus de toute suppression serveur. Dans v5,
`node --test scripts/test-assistant-actions.mjs` vérifie le parseur, l’aperçu,
la confirmation, le double clic, le changement de compte et l’absence de
réessai automatique. `node --env-file=.env examples/contact-actions-model-smoke.mjs`
exerce le modèle configuré avec des données Magileads entièrement fictives,
sans appeler les données clients ni effectuer de suppression. Le modèle peut
être précisé par `ACTION_TEST_MODEL` ; le script affiche les contrôles et le coût.

### Copier un segment de contacts vers une liste

L’outil `copy_contacts_to_list` accepte ce schéma d’arguments :

```json
{
  "source_list_id": 69964,
  "filter": {"mode":"and","values":[{"field_name":"2","type":"equals","value":"Monsieur"}]},
  "destination_list_id": 777
}
```

`source_list_id` et `filter` sont requis. `destination_list_id` désigne une
destination existante, vérifiée avec le jeton de l’appelant. Pour une nouvelle
liste, omettre ce champ ; `new_list_name` peut préciser le nom demandé par
l’utilisateur. Ces deux champs de destination sont exclusifs. Sans nom,
Magileads nomme la nouvelle copie. Si la destination de la demande est ambiguë,
le modèle doit la faire choisir avant de copier.

Le filtre accepte les groupes `and|or` imbriqués et les opérateurs documentés
`start_with`, `end_with`, `equals`, `not_equals`, `contains`, `not_contains`,
`more_than`, `more_or_equal_than`, `less_than`, `less_or_equal_than`, `does_exist`
et `does_not_exist`. `field_name` est un ID numérique en texte, vérifié contre
`/data-fields` ; `value` est une chaîne ou un tableau non vide de chaînes.
Les opérateurs de présence sont envoyés avec `value:""`. Un filtre vide, un
champ inconnu, une destination inaccessible ou identique à la source est refusé.

Après vérification de la source, de ses champs et du comptage en lecture seule,
le serveur appelle `POST /contact-lists/{source_list_id}/copy` avec :

```json
{
  "contacts_selection": {
    "contact_ids": [],
    "filter": {"mode":"and","values":[{"field_name":"2","type":"equals","value":"Monsieur"}]},
    "excluded_contact_ids": [],
    "reverse_selection": false
  },
  "contact_list_id_destination": 777
}
```

Pour une nouvelle liste, `contact_list_id_destination` est omis. Si un nom a
été demandé, le serveur renomme uniquement l’ID créé par cette copie avec
`PUT /contact-lists/{id}` `{name}`. Un échec du renommage est signalé sans
relancer ni supprimer la copie. Aucun contact de la source n’est supprimé.

Succès : `{operation:"copy_contacts_to_list",status:"accepted",source_list_id,
source_list_name,list_id,list_name,matched_contacts,criteria_applied:{filter},
warnings:[],note}`. Le nombre est celui de l’aperçu, pas un résultat définitif du
job. Le serveur émet `tool.progress` avec `creates_list:true`, un reçu `lists`
avec `purpose:"created"` portant l’ID de destination, et `assistant.changed`.
Le reçu n’est pas une carte de choix affichée par v5. Sans correspondance, il
renvoie `status:"no_matches"` sans mutation. Sans ID exploitable après un
succès API, il signale cette limite sans inventer de carte ni relancer le job.
Une répétition de la même copie est refusée au sein de la requête SSE.

La fonction figure aussi dans `discover_operations(group:"lists")` et est
appelable par `run_operation` avec `params:{id:<source>}` et le payload de copie
ci-dessus. Cette variante applique les mêmes validations. La copie d’un
segment ne peut pas remplacer le ciblage approuvé par le formulaire du mode
import ; elle est disponible en mode chat.

Vérifications : le Swagger public `/swagger.json` a été lu sur l’API Magileads
et confirme le chemin, les champs de sélection, les filtres imbriqués, les
opérateurs et le retour `contact_list_id` (HTTP 201).
`node --test src/contact-copy*.test.js` couvre les copies vers une liste
existante/nouvelle, les filtres invalides, l’aperçu indisponible, les erreurs,
le non-rejeu et les événements SSE. Aucun job n’a été lancé sur un compte réel.
Le script `node --env-file=.env examples/contact-copy-model-smoke.mjs` exerce le
fournisseur réel sur des listes entièrement fictives ; `COPY_TEST_MODEL` permet
de choisir son modèle.
La vérification avec `deepseek/deepseek-v4-pro` a confirmé l’attente du choix de
destination, la copie vers une nouvelle liste nommée, la copie vers une liste
existante par ID et l’absence de copie pour une simple demande de comptage.
Les deux copies de test transmettaient le filtre complet `Civilité = Monsieur`
pour les 16 contacts fictifs ; aucun appel aux données clients n’a été envoyé.

## Contrat SSE

Les deltas de texte et linkedin.accounts existants sont conservés.

Les commentaires `: connected` puis `: keep-alive` toutes les 15 secondes ne
constituent pas des événements et ne s’affichent pas. Le marqueur `data: [DONE]`
indique la fin normale. Le front v5 conserve le texte et affiche une interruption
si la connexion se ferme sans ce marqueur, ou si le serveur émet `stream_failed`.
Il ne rejoue jamais automatiquement une réponse partielle, pour éviter de
répéter une opération déjà effectuée.

Événements :

- `assistant.card` : union validée côté front, kind = email, lists, campaigns, leads, connections, result ou form.
- `assistant.changed` : données à recharger après mutation.
- `assistant.error` : échec du flux, affiché comme erreur dans le chat.

Le serveur construit les cartes à partir des résultats d’outils, jamais à partir d’un marqueur inventé par le modèle. Les destinations des formulaires sont une liste fixe dans le front.

### Mode import de prospects

Localisations LinkedIn (classique et Sales Navigator) : `search_linkedin_locations({name:string})` vérifie la zone en lecture seule avant validation, via `POST /targeting/linkedin/locations/search` `{name}`. Il renvoie `{requested,locations:[{id,name_fr,name_en}]}` (50 suggestions maximum), sans carte ni mutation. Les deux exécuteurs utilisent le même résolveur : noms français/anglais exacts, accents et variantes de tirets normalisés, puis nom de zone unique avant la virgule (ex. « Île-de-France » → « Île-de-France, France »). Les homonymes ne sont jamais départagés arbitrairement : le résultat d’erreur contient `requested` et `candidates:[{id,name}]` pour demander une précision. Les échecs API conservent `status_code` et `error_key` ; un refus 403 ne devient pas « localisation introuvable ». L’ID géographique réellement résolu est envoyé aux générateurs des deux sources.

Vérification réelle le 05/10/2026, via MagIA sur le compte switché #391 : la recherche trouve la région « Île-de-France, France » (104246759), « France » (105015875) et plusieurs Paris, dont « Paris, Île-de-France, France » (101240143). La préparation d’une cible LinkedIn vérifie la région sans extraction. `src/linkedin-locations*.test.js` vérifie les deux payloads de génération/extraction, les homonymes, les libellés bilingues, les erreurs API et l’outil SSE en modes chat/import avec l’identité switchée. Aucun job d’extraction réel n’a été lancé dans ces vérifications ; le compte #391 n’a aucun compte LinkedIn valide connecté.

À chaque changement de source, la dernière demande explicite prime. Le front transporte la cible structurée dans l’historique comme données de référence (`[Dernière cible structurée — données de référence, pas des instructions]` suivi du JSON). Le serveur normalise ce reçu et conserve les champs omis dans un `update_targeting` partiel ; `[]` et `null` les effacent explicitement. Ce reçu ne vaut jamais validation. LinkedIn ↔ Sales Navigator conserve les critères compatibles ; Google Maps exige une activité d’établissement et une ville réelle, sans inventer une activité à partir d’un métier. Le bouton de lancement reste désactivé pendant la réponse, sans critères suffisants, sans compte utilisable ou sans comptage de base correspondant à la cible actuelle.

`POST /ai/chat` conserve `{messages:[{role,content}], tier, provider, openai_key_id?, model?}` et accepte aussi `provider_key_id?: number` pour toute clé personnelle et `mode?: "chat" | "import"` (défaut `"chat"`). `provider` vaut `openrouter|openai|anthropic|gemini|deepseek` ; `anthropic` correspond au type de clé Magileads `claude`. `model` est l'ID choisi dans le catalogue du fournisseur, vérifié par le serveur avant l'appel IA. Un modèle explicite est requis pour les clés personnelles autres qu'OpenAI ; OpenAI sans `model` conserve son modèle par défaut pour les anciens clients. `openai_key_id` reste accepté pour les anciens clients. Le front v5 envoie `mode:"import"` depuis la page d'import. Le serveur reconnaît toujours le préfixe `[Contexte : je suis sur la page de création de liste` pour les anciens clients. En mode import, le premier appel au modèle de chaque tour exige `update_targeting`; les outils de mutation restent indisponibles avant une validation explicite et tant que `ready_to_launch` est faux. Le serveur reprend le nom donné dans `La cible me convient : crée la liste « Nom »…` pour les anciens clients et n'essaie qu'un lancement par réponse.

Le front conserve le formulaire de revue visible dès le premier tour, pendant les réponses et après les erreurs, même si la cible est incomplète. Il reste fixé en haut de la colonne droite sur desktop et passe sous la conversation sur mobile. Les nouvelles cibles mettent à jour les critères sans recréer le formulaire, effacer la destination ou les saisies inchangées. Le formulaire permet de modifier les critères pris en charge par la source, le plafond de contacts et la liste de destination ; seul son bouton final lance la recherche. Il envoie `import_approval?: {list_name:string} | {contact_list_id:number}`, augmenté de `targeting` (l'objet de critères ci-dessous), de `linkedin_account_id` pour LinkedIn/Sales Navigator et de `filters` pour la base Magileads. Le serveur exige une conversation avec une réponse préalable de l'assistant, recalcule `ready_to_launch`, vérifie l'objet et impose la destination, la source, les champs modifiables et `max_results` aux arguments de l'outil. Pour la base, il réutilise les filtres exacts du comptage. `list_name` et `contact_list_id` sont mutuellement exclusifs ; le nom ne dépasse pas 80 caractères. La traduction du texte du bouton ne change pas l'interprétation de la validation. La liste existante est vérifiée via `/contact-lists/{id}` avec le jeton de l'appelant. En mode explicitement `"import"`, un simple « go » dans le chat ne suffit plus : le formulaire est obligatoire. Les anciens clients reconnus par le préfixe de contexte gardent la validation textuelle. Le front bloque un second clic dans la même conversation ; une garantie d'idempotence entre appareils exigerait une clé d'idempotence persistée par l'API Magileads (ce serveur ne stocke pas les conversations).

`event: targeting.criteria` transporte **exactement** l'objet normalisé ci-dessous. Il vient de `update_targeting` (sans appel API) ; le serveur calcule `ready_to_launch` et `missing`. Cet outil n'émet ni `assistant.card` ni `assistant.changed`.

`event: targeting.count` transporte `{count:number,filters:object[]}` après un `count_database_targeting` réussi. Le front attend ce comptage et ses filtres avant d'autoriser le lancement d'une cible issue de la base Magileads. Pour LinkedIn et Sales Navigator, la revue s'affiche dès que les critères sont prêts ; le formulaire charge les comptes valides et sans checkpoint du compte actif, demande d'en choisir un, puis transmet son ID dans `import_approval`. Le bouton de lancement reste désactivé sans compte utilisable.

```json
{
  "source": null,
  "job_titles": [], "seniority": [], "sectors": [],
  "company_size_min": null, "company_size_max": null,
  "locations": [], "companies": [], "activity": null, "cities": [],
  "exclusions": [], "max_results": null,
  "ready_to_launch": false, "missing": []
}
```

`source` vaut `"linkedin"`, `"sales_navigator"`, `"database"`, `"google_maps"` ou `null`. Les tableaux ci-dessus contiennent des chaînes ; les deux bornes de taille et `max_results` sont des nombres ou `null`, `activity` est une chaîne ou `null`, `missing` contient les critères manquants en français. `ready_to_launch` exige notamment une activité et une ville pour Google Maps, ou une zone et un critère professionnel pour LinkedIn/Sales Navigator.

| Outil | Arguments | Résultat / droits |
| --- | --- | --- |
| `update_targeting` | Objet de critères ci-dessus, sans `ready_to_launch` ni `missing` | Retourne l'objet normalisé et émet `targeting.criteria` ; aucune mutation. |
| `count_database_targeting` | `{filters}` | `POST /targeting/database/count-preview`; retourne `{count, criteria_applied, note}`. Nécessite `displayTargetingDatabase`. Le compte doit être communiqué avant validation. |
| `run_database_targeting` | `{filters, list_name? | contact_list_id?, max_results?}` | `POST /targeting/database/extract`, `max_results` 100 par défaut, 10 000 max, langue `FRA`, pays `null`. Nécessite `accessTargetingDatabase`. |
| `run_sales_navigator_targeting` | `{titles?:string[], locations?:string[], industries?:string[], companies?:string[], company_head_counts?:string[], seniority_levels?:string[], linkedin_account_id:number, list_name? | contact_list_id?, max_results?, generate_email?}` | Génère l'URL puis lance l'extraction standard ou `-alternative` selon `useAlternativeTargeting`. Nécessite `accessSearchAI`, un compte Sales Navigator valide sans checkpoint ; 100 résultats par défaut, 1 000 max, `generate_email:true` par défaut. |
| `ask_linkedin_account` | `{sales_navigator_only?:boolean}` | Filtre la carte de sélection aux comptes valides, sans checkpoint et, si demandé, Sales Navigator. Aucun ID n'est inventé. |
| `run_linkedin_targeting`, `run_google_maps_targeting` | `list_name` **ou** `contact_list_id` en plus de leurs critères existants | Alimentent une liste existante avec `{contact_list_name:null, contact_list_id:id}`. La liste doit être accessible au compte appelant. |

Un filtre de base a la forme `{field, <opérateur>: string[]}` ou `{field, exists: boolean}`. Champs texte permis : `job_title`, `contact_location`, `company`, `company_size`, `activity`, `category`, `zip_code`, `naf_code`, `country`. Opérateurs : `contains`, `does_not_contain`, `starts_with`, `does_not_start_with`, `ends_with`, `does_not_end_with`, `exact_match`. `zip_code` utilise `starts_with`; `naf_code` a cinq caractères ; `company_size` accepte `0-10`, `11-50`, `51-200`, `201-500`, `501-1000`, `1001-5000`, `5001-10000`, `10001+`. `exists` est réservé à `phone`, `linkedin_url`, `website`, `summary`. Les valeurs `contact_location` sont résolues par `/targeting/database/locations/search` avant comptage et extraction. Les filtres invalides ou les localisations ambiguës bloquent le lancement.

Payloads Magileads envoyés par les nouveaux outils (les tableaux vides sont omis du premier) :

```text
POST /targeting/linkedin/generate-sales-navigator-peoples-search-url
{"current_titles":["Directeur"],"locations":[105015875],"industries":[4],"current_companies":["Acme"],"company_head_counts":["51-200"],"seniority_levels":["director"]}
POST /targeting/linkedin/extract-sales-navigator-peoples-search[-alternative]
{"linkedin_sales_navigator_search_url":"https://www.linkedin.com/sales/search/people?...","linkedin_people_search_url":"https://www.linkedin.com/sales/search/people?...","linkedin_account_id":7,"generate_email":true,"max_results":100,"contact_list_name":"Prospects","contact_list_id":null,"contact_list_language":null,"contact_list_country":null,"exclude_viewed_leads":false,"exclude_crm_contacts":false}
POST /targeting/database/count-preview
{"filters":[{"field":"contact_location","contains":["Paris, France"]}]}
POST /targeting/database/extract
{"contact_list_name":"Prospects","contact_list_id":null,"max_results":100,"filters":[{"field":"contact_location","contains":["Paris, France"]}],"contact_list_country":null,"contact_list_language":"FRA"}
```

Pour alimenter une liste existante, les deux clés deviennent `"contact_list_name":null,"contact_list_id":123`. Les arguments d’outil restent des chaînes pour les noms de lieux et secteurs ; après résolution, `locations` et `industries` sont envoyés à Magileads comme des entiers JSON, conformément au Swagger public et à `AiImport.jsx` / `QuickImport.jsx` de la v4. Les postes, entreprises, effectifs et niveaux restent des chaînes.

Comparaison avec « Import avec IA » v4 le 05/10/2026 : même générateur `generate-sales-navigator-peoples-search-url`, puis extraction `extract-sales-navigator-peoples-search` (ou `-alternative` selon la permission). La v4 lit `linkedin_url`, accepté par le serveur avec `search_url` et `url`. Le serveur vérifie aussi les filtres via plusieurs appels de génération, puis envoie une seule extraction après validation humaine, avec le compte choisi (la v4 envoyait `linkedin_account_id:null`). Un échec du premier générateur renvoie désormais `{error,stage:"search_url_generation",error_key,status_code,note}` sans extraction. Les données brutes de l’API ne sont pas exposées ; le modèle ne doit pas inventer une panne de session ou d’abonnement. Vérification du Swagger public actuel et tests de payloads/échecs ; aucune génération ni extraction authentifiée réelle effectuée pour ce correctif.

Chaque `run_*` réussi retourne `{status:"extraction lancée", list_id, list_name, criteria_applied, note}`. Les extractions Sales Navigator rapportent les filtres ignorés dans `criteria_applied.ignored_filters` et `note`. Les codes de secteur viennent du catalogue du sélecteur v4 ; effectifs et niveaux utilisent les valeurs exposées dans le Swagger Magileads. Pour chacun, le serveur compare l'URL obtenue avec et sans filtre avant de l'annoncer comme appliqué. Les événements existants restent inchangés : `tool.progress` avec `creates_list:true`, puis `assistant.card` `{kind:"lists", items:[{id,name}]}` sur succès, et `assistant.changed` pour invalider les données.

`SERVER_URL=... TOKEN=... node examples/import-smoke.mjs` imprime le flux réel sans lancer d'extraction. Définir en plus `VALIDATE_NAME="Nom"` envoie la validation et autorise une extraction réelle. Le script échoue si un reçu de création de liste ou un progrès de création arrive avant validation ; un choix de liste est permis.

Le Swagger public de `https://app.api-magileads.net/swagger.json` confirme les chemins, les champs `contact_list_id` des trois extractions, les schémas de filtres et les enums `CompanyHeadCount` / `SeniorityLevel`. Aucun appel authentifié aux endpoints de génération, comptage ou extraction n'a été effectué lors de cette implémentation ; l'acceptation effective des valeurs et les permissions d'un compte réel restent à vérifier avec un `TOKEN` de test. Les tests HTTP locaux simulent ces réponses et vérifient les payloads, les cartes et le blocage avant validation.

## Vérification et mise en service

- Serveur : `node --test src/*.test.js` (intégration OpenAI Magileads par compte, absence de stockage local, outils et flux HTTP).
- Front : `node scripts/test-assistant.mjs`, `npm run typecheck` et lint des fichiers Assistant.
- Tests navigateur : prototype v0 exécuté dans une copie temporaire (dépendances v5 ; analytics et import shadcn CSS indisponible retirés dans cette copie uniquement), audit affiché ; cartes v5 sur données fictives, clic Dupliquer, ouverture du formulaire SMTP. Les sources v0 sont intactes.
- Aucun envoi réel, enrichissement payant ou duplication sur un compte de production effectué. Le flux HTTP complet est testé contre un fournisseur et une API simulés ; les tests ne valident pas les droits/quota d’un compte réel ni toutes les réponses possibles de l’API.
- Le contrôle global i18n a signalé des clés manquantes dans les fichiers PRM modifiés parallèlement ; ce chantier ne les corrige pas.

**Déployer le serveur IA et le front ensemble.** Le front utilise AI_SERVER_URL et pointe par défaut sur https://magileads-ai-server.krypha.com. Modifier les fichiers locaux du serveur ne modifie pas ce service distant. En local, définir AI_SERVER_URL sur l’instance locale pour tester l’ensemble, puis utiliser un compte de test connecté. Les anciennes instances serveur n’émettent pas les nouvelles cartes et conservent leur ancienne politique de suppression.

Ajouter la clé dans **Magileads → Paramètres → Intégrations**. Le serveur IA ne requiert ni `AI_CREDENTIALS_KEY` ni volume persistant. `GET /ai/providers` renvoie `keys` par fournisseur (`[{id,name}]`), ainsi que les anciens champs `openai_keys` et `configured`. `GET /ai/models?provider=openai&key_id=123` (même forme pour les autres fournisseurs) récupère en direct la liste `models:[{id,name}]` auprès du fournisseur avec la clé du compte authentifié ; la clé n'est jamais renvoyée. Aucun catalogue fixe ni clé locale n'est enregistré.

## Catalogue

La liste détaillée ci-dessous est issue du registre exécuté par le serveur.

### lists (20)

- duplicate_contact_list — POST /contact-lists/:id/copy
- copy_contacts_to_list — POST /contact-lists/:id/copy (contacts_selection + destination optionnelle)
- enrich_dropcontact — POST /contact-lists/:id/enrich/external/dropcontact/:key_id
- create_contact_list — POST /contact-lists
- update_contact_list — PUT /contact-lists/:id
- split_contact_list — POST /contact-lists/:id/split
- copy_list_to_prm — POST /contact-lists/:id/copy/prm
- enrich_contact_list — POST /contact-lists/:id/enrich
- verify_list_emails — POST /contact-lists/:id/email-verifier
- translate_contact_list — POST /contact-lists/:id/translate
- resolve_linkedin_urls — POST /contact-lists/:id/enrich/linkedin/url
- create_contact — POST /contact-lists/:id/contact
- update_contact — PUT /contact-lists/:id/contacts/:contact_id
- list_blacklists — GET /blacklists
- get_blacklist — GET /blacklists/:id
- create_blacklist — POST /blacklists
- update_blacklist — PUT /blacklists/:id
- add_blacklist_entries — POST /blacklists/:id/data
- list_unsubscribers — GET /unsubscribers
- add_unsubscribers — POST /unsubscribers/

### campaigns (13)

- list_workflows — GET /workflows
- create_workflow — POST /workflows
- update_workflow — PUT /workflows/:id
- duplicate_workflow — POST /workflows/:id/copy
- pause_campaign — PUT /workflows/:workflow_id/programmation/:id/stop
- resume_campaign — PUT /workflows/:workflow_id/programmation/:id/resume
- archive_campaign — PUT /workflows/:workflow_id/programmation/:id/archive
- unarchive_campaign — PUT /workflows/:workflow_id/programmation/:id/unarchive
- schedule_campaign — POST /workflows/:workflow_id/program
- get_campaign_schedule — GET /workflows/:workflow_id/programmation/:id
- update_campaign_schedule — PUT /workflows/:workflow_id/programmation/:id
- pause_campaign_step — PUT /workflows/:workflow_id/programmation/:id/step/:step_id/stop
- resume_campaign_step — PUT /workflows/:workflow_id/programmation/:id/step/:step_id/resume

### reporting (3)

- get_global_reporting — GET /statistics/global
- get_period_reporting — POST /statistics/global/detailed
- get_daily_reporting — POST /statistics/date/detailed

### models (26)

- list_email_models — GET /models/email
- get_email_model — GET /models/email/:id
- create_email_model — POST /models/email
- update_email_model — PUT /models/email/:id
- list_linkedin_message_models — GET /models/linkedin/message
- get_linkedin_message_model — GET /models/linkedin/message/:id
- create_linkedin_message_model — POST /models/linkedin/message
- update_linkedin_message_model — PUT /models/linkedin/message/:id
- list_linkedin_invitation_models — GET /models/linkedin/invitation
- get_linkedin_invitation_model — GET /models/linkedin/invitation/:id
- create_linkedin_invitation_model — POST /models/linkedin/invitation
- update_linkedin_invitation_model — PUT /models/linkedin/invitation/:id
- list_sms_models — GET /models/sms
- get_sms_model — GET /models/sms/:id
- create_sms_model — POST /models/sms
- update_sms_model — PUT /models/sms/:id
- list_vms_models — GET /models/smv
- get_vms_model — GET /models/smv/:id
- create_vms_model — POST /models/smv
- update_vms_model — PUT /models/smv/:id
- list_signature_models — GET /email-signatures
- get_signature_model — GET /email-signatures/:id
- create_signature_model — POST /email-signatures
- update_signature_model — PUT /email-signatures/:id
- list_files — GET /files
- get_file — GET /files/:id

### organization (13)

- list_tags — GET /tags
- create_tag — POST /tags
- update_tag — PUT /tags/:id
- list_folders — GET /folders
- create_folder — POST /folders
- update_folder — PUT /folders/:id
- list_data_fields — GET /data-fields
- create_data_field — POST /data-fields
- update_data_field — PUT /data-fields/:id
- list_short_links — GET /urls-shortener
- create_short_link — POST /urls-shortener
- update_short_link — PUT /urls-shortener/:id
- get_folder — GET /folders/:id

### agents (5)

- list_ai_agents — GET /ai-agents
- get_ai_agent — GET /ai-agents/:uniqid
- create_ai_agent — POST /ai-agents
- update_ai_agent — PUT /ai-agents/:uniqid
- generate_agent_brief — POST /ai-agents/generate-brief

### senders (6)

- list_email_accounts — GET /integrations/email
- list_sender_pools — GET /pools
- get_sender_pool — GET /pools/:id
- create_sender_pool — POST /pools
- add_account_to_pool — POST /pools/:id/:account_id
- get_email_account — GET /integrations/email/:id

### targeting (3)

- relaunch_linkedin_errors — POST /targeting/linkedin/:id/relaunch-errors
- refresh_linkedin_targeting — POST /targeting/linkedin/refresh/:id
- relaunch_google_targeting — POST /targeting/google/extract-maps-search/:id/relaunch

### prm (11)

- update_prm_contact — PUT /prm/contact/:id
- move_prm_contacts — PUT /prm/contacts/status
- copy_prm_to_list — POST /prm/contacts/contact-list/:id/add
- set_prm_new_reply — PUT /prm/contacts/new_reply
- tag_prm_contacts — POST /prm/contacts/user/:user_id/tags
- enrich_prm_mobile — POST /prm/contact/:id/enrich/phone/mobile
- create_prm_note — POST /prm/contact/:id/note
- update_prm_note — PUT /prm/contact/:id/note/:note_id
- create_prm_reminder — POST /prm/contact/:id/call
- create_prm_status — POST /prm/status/custom
- update_prm_status — PUT /prm/status/custom/:id

### automation (8)

- list_crons — GET /crons
- get_cron — GET /crons/:id
- list_zapier_hooks — GET /zapier
- get_zapier_hook — GET /zapier/:id
- activate_zapier_hook — PUT /zapier/:id/activate
- deactivate_zapier_hook — PUT /zapier/:id/deactivate
- list_webhooks — GET /webhooks
- get_webhook — GET /webhooks/:id

### messages (3)

- send_email — POST /workflows/send/email
- send_linkedin_message — POST /prm/contact/:id/linkedin/message
- send_linkedin_invitation — POST /prm/contact/:id/linkedin/invitation
