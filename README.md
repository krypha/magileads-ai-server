# Magileads AI Server

Serveur **autonome** de l'assistant IA Magileads : même comportement que la route
`/api/ai/chat` de l'application Next.js, mais utilisable depuis **n'importe quel
front** (ReactJS, autre application web, mobile…).

- **Zéro dépendance** — fonctionne avec **Bun** ou **Node 18+** (`node:http` + `fetch`).
- **Tout en JS** (ESM), pas de TypeScript.
- **Streaming SSE** : la réponse arrive au fil de l'eau.
- **Tool-calling** : 18 outils qui interrogent le compte Magileads **de
  l'utilisateur appelant**.

---

## 1. Principe

Le modèle **n'a aucune mémoire** : à chaque message, le serveur réassemble
`prompt système + historique + outils` et l'envoie au fournisseur choisi :
OpenRouter (clé de la plateforme) ou OpenAI (intégration du compte Magileads).

```
Front ──(token Magileads)──► ai-server ──► modèle (OpenRouter / OpenAI)
                                 │              │
                                 │   « appeler list_campaigns »
                                 ▼
                        API Magileads (avec le token DE L'UTILISATEUR)
                                 │
                                 └──► résultat ──► modèle ──► réponse (SSE)
```

**Sécurité** : le token de l'utilisateur sert à lire son intégration OpenAI et à
exécuter les outils côté serveur. Il **n'entre jamais** dans le contexte du
modèle, qui ne reçoit que les *résultats*. Chaque utilisateur n'accède donc
qu'à **ses** données.

**Le serveur ne rafraîchit pas les tokens** : le front s'en charge déjà
(interceptor axios + Web Locks). Lorsqu'un token est expiré, le serveur répond
`401` avec `{ state_message: "token_expired" }`, à charge du client de rafraîchir
et de rejouer la requête.

---

## 2. Installation et lancement

```bash
cp .env.example .env     # renseigner AI_API_KEY pour OpenRouter
bun install              # aucune dépendance, crée simplement le lockfile
bun run start            # → http://localhost:8787
```

Sans Bun :

```bash
npm run start:node       # node --env-file=.env src/server.js
```

### Variables d'environnement

| Variable             | Rôle                                                              |
| -------------------- | ----------------------------------------------------------------- |
| `PORT`               | Port d'écoute (défaut `8787`)                                       |
| `ALLOWED_ORIGINS`    | Origines CORS autorisées, séparées par des virgules (`*` en dev)    |
| `RATE_LIMIT_PER_MIN` | Requêtes max par utilisateur et par minute (défaut 20)              |
| `AI_TEST_UNLIMITED_UNTIL` | Date/heure d’expiration des tests sans plafonds d’usage, au format ISO UTC. Vide par défaut : limites normales actives. |
| `MAGILEADS_API_BASE` | `https://app.api-magileads.net`                                     |
| `AI_API_URL`         | Hôte OpenRouter (défaut `https://openrouter.ai/api/v1`)             |
| `AI_API_KEY`         | Clé OpenRouter de la plateforme (**serveur uniquement**)           |
| `AI_INCLUDED_API_KEY` | Clé OpenRouter dédiée aux comptes `level=user`, plafonnée à 3 USD avec `limit_reset=daily`. Sans plafond vérifiable, le serveur utilise le modèle gratuit. |
| `AI_API_KEY_FREE`   | Clé distincte recommandée pour le repli gratuit après épuisement du budget (à défaut : `AI_API_KEY`). |
| `AI_MODEL_INCLUDED` | Modèle Simple des comptes `level=user`. Si vide, reprend `AI_MODEL` ; si les deux sont vides, `deepseek/deepseek-v4-flash`. |
| `AI_MODEL_FREE`      | Palier « Gratuit » — défaut `openrouter/free` (routeur géré par OpenRouter). Accepte aussi une liste séparée par des virgules, essayée dans l'ordre |
| `AI_MODEL`           | Modèle du palier « Simple » (palier par défaut)                     |
| `AI_MODEL_COMPLEX`   | Modèle du palier « Complexe » (si vide → identique à Simple)        |
| `ALLOW_CUSTOM_MODEL` | `false` pour désactiver le palier « Perso. »                         |
| `OPENAI_MODEL` / `OPENAI_MODEL_COMPLEX` | Modèles OpenAI par défaut : `gpt-5.4-mini` / `gpt-5.4` |

> ⚠️ Le modèle doit supporter le **function calling**.

### Tests sans plafonds d’usage

Définir `AI_TEST_UNLIMITED_UNTIL` dans l’environnement du **serveur IA**, avec une
date future ISO UTC, puis redémarrer/redéployer. Exemple pour tester jusqu’au
30 septembre 2026 à 23 h 59 à Madagascar :

```dotenv
AI_TEST_UNLIMITED_UNTIL=2026-09-30T20:59:59Z
```

Pendant cette période, le serveur ne transmet aucun `max_tokens` au modèle
pour la réponse, ne tronque ni les messages ni leur
historique et suspend les limites de prompt, coût par requête, prix des providers,
trois campagnes, douze outils et requêtes par minute. La limite de six tours
d’outils et le délai de 120 secondes par appel modèle sont également suspendus :
le serveur continue jusqu’à la réponse finale ou l’arrêt par l’utilisateur.
Les résultats des outils ne sont plus remplacés par un aperçu quand leur JSON
dépasse 8 000/12 000 caractères (ou le seuil propre à l’outil). La liste complète
des modèles renvoyée par l’API et le contenu des modèles restent disponibles
pour le modèle IA, y compris les dernières entrées. Les secrets et diagnostics
d’audit exclus restent retirés avant cette transmission.
Le précontrôle de la clé
journalière OpenRouter est suspendu ; l’IA incluse utilise en priorité
`AI_API_KEY`, puis `AI_INCLUDED_API_KEY` si la clé de plateforme manque. Les
budgets, quotas et fenêtres de contexte imposés par OpenRouter/OpenAI continuent
de s’appliquer : ce réglage ne les modifie pas.

La date est vérifiée pour chaque nouvelle requête. Une valeur absente, invalide
ou expirée réactive les limites normales, sans redémarrage à l’expiration. La
valeur ne peut pas venir du corps `/ai/chat`. `GET /ai/meta` indique
`usageLimitsEnabled:false` pendant les tests, puis `true` après expiration.
Ce statut décrit MagIA, pas les clés personnelles, qui restent sans plafond
d’usage applicatif.
Pour arrêter les tests plus tôt, retirer la variable et redémarrer le serveur.

L’authentification, les clés propres au compte, la validation d’import,
la politique de suppression et la suppression des secrets
restent actifs. La requête HTTP reste plafonnée à 8 Mo. La pagination et les
tailles de pages prévues par les outils de lecture restent applicables. Hors
tests, les résultats volumineux sont plafonnés ; après six tours d’outils, un dernier appel sans
autorisation d’outils demande une synthèse factuelle, avec les informations
manquantes si nécessaire, plutôt que fermer silencieusement le flux.
`GET /ai/meta` expose aussi `executionLimits` : `maxToolRounds` et
`modelCallTimeoutMs` valent `null` pendant les tests, sinon `6` et `120000`.
`toolResultTruncationEnabled` vaut `false` pendant les tests, `true` hors tests.

### Intégration OpenAI du compte

La clé OpenAI est créée et conservée dans **Magileads → Paramètres →
Intégrations**. Après authentification avec `GET /users/me`, le serveur IA lit
`GET /external-api-keys` avec les identifiants du compte actif (y compris après
  un switch) et utilise la clé OpenAI choisie pour cet appel uniquement. Si le
  compte n'en a qu'une, elle est utilisée automatiquement ; s'il en a plusieurs,
  `openai_key_id` est obligatoire et doit correspondre à une clé du compte actif.
Il ne la met ni en fichier, ni en cache, ni dans le prompt ou l'historique du
  chat. `GET /ai/providers` n'expose que les noms et ID des intégrations.

Les appels avec une clé personnelle sont facturés au titulaire de la clé
enregistrée dans Magileads. Le palier « Gratuit » reste réservé à OpenRouter.

Pour un compte dont `/users/me` indique `level: "user"`, le serveur impose
`tier: "simple"` même si le client envoie un autre palier ; le front masque
le sélecteur. Avec l'IA incluse, le serveur vérifie `GET /api/v1/key`
auprès d'OpenRouter avant chaque chat : la clé doit avoir un plafond de
3 USD maximum, `limit_reset: "daily"` et un solde positif. Sinon il choisit
`AI_MODEL_FREE` avant l'appel. Un refus 402/429 du modèle payant déclenche
aussi ce repli. Le plafond est appliqué par OpenRouter entre toutes les
instances ; le serveur IA ne stocke aucun compteur ni clé utilisateur.

Le modèle des comptes `level=user` suit la priorité `AI_MODEL_INCLUDED` →
`AI_MODEL` → `deepseek/deepseek-v4-flash`, y compris pendant les tests sans
plafonds. `AI_MODEL_COMPLEX` ne choisit pas le modèle de leur palier Simple.
Pour utiliser Pro pour les utilisateurs et les administrateurs :

```dotenv
AI_MODEL=deepseek/deepseek-v4-pro
AI_MODEL_COMPLEX=deepseek/deepseek-v4-pro
AI_MODEL_INCLUDED=deepseek/deepseek-v4-pro
```

On peut aussi laisser `AI_MODEL_INCLUDED` vide pour qu’il reprenne `AI_MODEL`.
Le fichier Compose transmet ces variables au conteneur, ainsi que les clés et
réglages du budget inclus. Après un changement d’environnement, recréer le
conteneur/redéployer. Le log de démarrage `included=...` indique le modèle
effectivement configuré pour les utilisateurs ; `model.info` indique le modèle
de la réponse, éventuellement gratuit après un repli.

L'IA incluse refuse avant l'appel au modèle un dernier message de plus de
4 000 caractères ou un historique de plus de 24 000 caractères (`413
shared_prompt_too_large`). Chaque réponse est limitée à 2 048 tokens par
tour de modèle. Une clé OpenAI personnelle n'est pas soumise à ces limites.
Un budget par requête de **0,03 USD** (`AI_INCLUDED_MAX_REQUEST_USD`, maximum
configurable 0,10 USD) couvre la réponse et tous les tours d’outils.
Avant chaque appel, le serveur réserve une estimation prudente incluant le
prompt système, les messages, les schémas des outils, leurs résultats et la
sortie maximale. L’estimation utilise les octets UTF-8, une marge de framing et
20 % de sécurité ; ce n’est pas un comptage exact par tokenizer. Le coût
`usage.cost` renvoyé par OpenRouter remplace ensuite la réservation ; s’il manque,
elle est conservée. Le tour suivant est refusé s’il dépasse le budget. Les
actions déjà effectuées et leurs cartes restent transmises ; aucun lancement
n’est annulé ni répété automatiquement.

OpenRouter reçoit `provider.max_price` avec, par défaut, **0,25 USD/M tokens
d’entrée**, **1,50 USD/M tokens de sortie**, et `request: 0`. Les plafonds
s’appliquent aux providers sélectionnés et à leurs fallbacks. Réglages :
`AI_INCLUDED_MAX_INPUT_USD_PER_M`, `AI_INCLUDED_MAX_OUTPUT_USD_PER_M`. Le repli
gratuit accepte uniquement `openrouter/free` ou un slug `:free`, avec des prix
maximums à zéro. Les règles de volume restent actives après ce repli : douze
appels d’outils maximum, trois campagnes consultées en détail maximum, contexte
plafonné à 120 000 octets avec le framing. Les rapports par période/jour exigent
une sélection de une à trois campagnes ; le résumé global reste disponible.

**Sujets libres dans tous les assistants :** MagIA et les clés personnelles
peuvent répondre aux questions générales comme aux demandes Magileads, dans
l’assistant principal, la bulle, le reporting et l’import. Aucun appel de
classification thématique ne précède la réponse ; les erreurs `off_topic` et
`scope_check_unavailable` ne sont plus émises. Une question générale ne nécessite
pas d’outil métier. Les données et actions Magileads restent limitées au compte
authentifié, avec les validations d’import et de suppression habituelles. Les
limites de coût et de volume de l’IA incluse restent applicables lorsqu’elles
sont activées.

Avec une clé personnelle OpenAI, Claude, Gemini, DeepSeek ou OpenRouter, le
serveur ne plafonne ni l’historique, ni la sortie, ni les tours d’outils, ni la
durée d’un appel modèle, ni les résultats des outils. L’authentification du
compte, ses permissions, les validations d’import, la confirmation humaine des
suppressions, la protection des secrets et les limites techniques du fournisseur
restent applicables. La requête HTTP reste plafonnée à 8 Mo.
Pour Claude, l’API exige `max_tokens` : le serveur utilise la limite de sortie
annoncée par le catalogue du modèle choisi, lorsqu’elle est disponible.

Les compteurs de budget sont locaux à la requête et disparaissent à sa fin.
Un quota journalier exact par compte (y compris entre instances ou requêtes
concurrentes) nécessitera un endpoint de réservation/compteur dans l’API
Magileads. Le plafond partagé quotidien reste appliqué par OpenRouter. Les clés
personnelles lèvent les plafonds de coût/volume de l’IA incluse.

Vérification locale : `node --test src/*.test.js`. Vérification réelle de la
liberté de sujet dans les différents contextes, avec de petites requêtes
facturées par le provider, sans accès
aux données Magileads : `node --env-file=.env examples/policy-model-smoke.mjs`.

---

## 3. API

### `POST /ai/chat` → flux SSE

**En-têtes**

```
Content-Type: application/json
Authorization: Bearer <access_token Magileads du compte principal>
X-API-Key:     <token du compte SWITCHÉ>        (optionnel)
```

⚠️ **Compte switché** : les **deux** en-têtes doivent être envoyés, comme le fait
l'interceptor axios de l'application (`config.headers["X-API-Key"] =
user_switch.token`). Le serveur les transmet **tels quels** à Magileads, qui
**privilégie `X-API-Key`** (vérifié : Bearer valide + `X-API-Key` invalide →
`401`). L'assistant opère ainsi sur le **même compte** que le reste de
l'application. Le composant Mantine gère ce cas via `getAuthHeaders`.

**Corps**

```json
{
  "provider": "openrouter",
  "tier": "simple",
  "messages": [
    { "role": "user", "content": "Combien de campagnes ai-je ?" },
    { "role": "assistant", "content": "Vous avez 2 campagnes." },
    { "role": "user", "content": "Et des listes ?" }
  ]
}
```

- `tier` : `"free"` | `"simple"` | `"complex"` | `"custom"`. Le nom du modèle reste
  côté serveur, **sauf** pour `custom`.
- `provider` : `"openrouter"` (défaut rétrocompatible) ou `"openai"`.
  OpenAI exige une intégration enregistrée dans Magileads pour le compte appelant.
- `openai_key_id` : ID de l'intégration OpenAI à utiliser. Obligatoire si le
  compte actif possède plusieurs clés. Le serveur vérifie la propriété à chaque appel.
- `model` : **uniquement** avec `tier: "custom"` — identifiant du modèle (ex.
  `stealth/ox-alpha`). Format validé côté serveur (`editeur/modele`) ; sinon
  `400 invalid_custom_model`.
- `messages` : l'historique complet (le modèle est sans mémoire). Seuls les rôles
  `user` et `assistant` sont acceptés — un client ne peut pas injecter de `system`.

**Paliers de modèle**

| Palier | Modèle utilisé | Particularité |
| ------ | -------------- | ------------- |
| `free` | `AI_MODEL_FREE` (défaut `openrouter/free`) | OpenRouter sélectionne lui-même un modèle gratuit. Si une liste est épinglée, **bascule automatique** sur le suivant en cas de 429/404/402 |
| `simple` | `AI_MODEL` pour les admins ; `AI_MODEL_INCLUDED` puis `AI_MODEL` puis Flash pour `level=user` | palier par défaut |
| `complex` | `AI_MODEL_COMPLEX` | retombe sur `AI_MODEL` si non défini |
| `custom` | fourni par le client | permet de tester un modèle précis |

**Réponse : `text/event-stream`**

| Événement                 | Charge utile                                                       | Usage                                |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------ |
| *(sans event)*            | `{"choices":[{"delta":{"content":"…"}}]}`                            | fragment de texte à concaténer       |
| `event: tool.progress`    | `{tool,label,status:"running"\|"completed",creates_list}`            | indicateur « ⚙️ Lecture des listes… » |
| `event: linkedin.accounts`| `{accounts:[{id,name,username}]}`                                    | carte cliquable de choix de compte   |
| `event: model.info`       | `{tier, model, fallback}`                                            | modèle réellement utilisé (utile lorsqu'un repli a eu lieu sur le palier Gratuit) |
| *(sans event)*            | `[DONE]`                                                             | fin du flux                          |

**Codes d'erreur** : `401` (token absent ou expiré → rafraîchir puis rejouer),
  `413` (`shared_prompt_too_large` : réduire la demande ou connecter une clé OpenAI),
  `429` (rate limit), `409` (choix de clé OpenAI nécessaire), `412` (intégration
  OpenAI absente ou clé choisie inaccessible), `502` (lecture de
l'intégration Magileads indisponible), `503` (OpenRouter non configuré), `400`
(corps vide, fournisseur/palier/modèle personnalisé invalide). Un refus de clé
par OpenAI est signalé dans le flux par `assistant.error` avec
`provider_key_invalid`.

### Disponibilité des fournisseurs

- `GET /ai/providers` → `{openrouter_available, configured: {openai, anthropic:false}, openai_keys: [{id, name}]}` ; aucun secret.

Cette route exige les mêmes identifiants Magileads que `/ai/chat`. L'ajout, la
modification et la suppression d'une clé se font uniquement dans Magileads.
L'ancien endpoint d'écriture `/ai/provider-keys` a été retiré.

### `GET /health` → `{ ok, openrouter_available }`
### `GET /ai/meta` → `{ toolLabels, createsList, tiers }` (libellés FR pour l'indicateur)

---

## 4. Marqueurs dans le texte

Deux conventions à gérer côté front (les composants d'exemple les implémentent) :

1. **`[[CONFIRM_DELETE]]{...}[[/CONFIRM_DELETE]]`** — avant toute suppression,
   l'assistant émet ce marqueur avec le **nombre exact** de contacts. Le front
   affiche une **carte de confirmation** ; sans validation explicite, rien n'est
   supprimé. *(Sécurité réelle : côté serveur, la suppression recompte et refuse
   si le nombre a changé, et un filtre vide est interdit.)*

2. **Carte de comptes LinkedIn** — construite **par le serveur** à partir du vrai
   résultat d'outil (événement `linkedin.accounts`), **jamais** depuis le texte du
   modèle. Si le modèle émet malgré tout `[[PICK_ACCOUNT]]`, le front doit
   l'**ignorer et le retirer** de l'affichage : c'est ce qui empêche un petit
   modèle d'**inventer** un compte inexistant.

---

## 5. Intégration avec ReactJS

Deux exemples sont fournis :

| Fichier | Usage |
| ------- | ----- |
| **`examples/mantine/`** ⭐ | **Recommandé** — reprise complète de l'assistant `/ai` en **Mantine** |
| `examples/AiAssistant.jsx` | Version sans aucune dépendance (styles inline), utile comme référence |

### Version Mantine (recommandée)

Copier le dossier `examples/mantine/` dans le projet (3 fichiers :
`AiAssistant.jsx`, `MarkdownMessage.jsx`, `exportReport.js`).

```bash
npm i react-markdown remark-gfm      # @mantine/core, @mantine/notifications
                                     # et @tabler/icons-react sont supposés présents
```

```jsx
import AiAssistant from "./ai/AiAssistant";
import { mainAxios } from "../api/axios";
import { useSessionStore, useProfileStore } from "../stores/UserStore";
import { useNavigate } from "react-router-dom";

export default function AiPage() {
  const navigate = useNavigate();
  const profile = useProfileStore((s) => s.profile);

  return (
    <AiAssistant
      serverUrl={window._env_.AI_SERVER_URL}
      // En-têtes relus À CHAQUE envoi : compte principal + compte switché.
      getAuthHeaders={() => {
        const s = useSessionStore.getState();
        return {
          ...(s.session?.access_token
            ? { Authorization: `Bearer ${s.session.access_token}` }
            : {}),
          ...(s.user_switch?.token ? { "X-API-Key": s.user_switch.token } : {}),
        };
      }}
      // Sur 401 : déclenche l'interceptor (refresh + Web Lock), puis rejeu automatique.
      onAuthError={async () => {
        try { await mainAxios.get("/users/me"); } catch { /* géré par l'interceptor */ }
      }}
      apiClient={mainAxios}                 // optionnel : notifie la fin des ciblages
      userKey={profile?.email}              // optionnel : conversation persistée par utilisateur
      onOpenList={(id) => navigate(`/contact-lists/${id}`)}
      height="calc(100vh - 140px)"
    />
  );
}
```

**Fonctionnalités** : streaming et indicateur d'outil, **rendu Markdown** (titres,
**tableaux d'audit** défilables, listes, code, liens), **Copier** sur chaque
message, **Exporter** un rapport HTML/PDF imprimable, sélecteur de modèle
**Gratuit / Simple / Complexe / Perso.**, **carte cliquable des comptes
LinkedIn**, **garde-fou** avant suppression, notification de **fin de ciblage**
avec lien vers la liste créée, conversation **persistée**, bouton **Stop** et
rejeu automatique après un 401.

**Prérequis** : Mantine **v7+** (le mapping des tableaux utilise `Table.Thead`).
Sous Mantine v6, remplacer ces mappings par `thead/tbody/tr/th/td` dans
`MarkdownMessage.jsx`. Testé avec `react-markdown` v9 et v10.

> ⚠️ Ne **jamais** ajouter `rehype-raw` dans `MarkdownMessage.jsx` : le contenu
> provient d'un LLM et il est réutilisé tel quel dans l'export du rapport — ce
> serait une faille XSS.

L'origine du front doit être déclarée dans `ALLOWED_ORIGINS`.

---

## 6. Outils disponibles (18)

| Domaine        | Outils                                                                              |
| -------------- | ----------------------------------------------------------------------------------- |
| Compte         | `get_account_overview`, `list_linkedin_accounts`                                      |
| Campagnes      | `list_campaigns`, `get_campaign`, `get_campaign_statistics`                           |
| Listes         | `list_contact_lists`, `get_contact_list`, `list_contact_fields`                       |
| Contacts       | `query_contacts`, `preview_contact_selection`, `delete_contacts_by_selection` ⚠️      |
| PRM (CRM)      | `list_prm_statuses`, `query_prm_contacts`, `get_prm_contact`, `list_prm_nurturings`   |
| Ciblage        | `run_google_maps_targeting`, `ask_linkedin_account`, `run_linkedin_targeting`         |

⚠️ = action destructive, protégée par le garde-fou de confirmation.
Le ciblage **consomme des crédits** et crée une liste (extraction asynchrone).

`list_contact_lists` balaie **toutes** les listes du compte (endpoint non paginé) :
les tris `contacts` / `emails` / `linkedin` et les totaux renvoyés sont donc
exacts, y compris sur les comptes comportant plusieurs milliers de listes.

---

## 7. Déploiement (Docker / Dokploy)

Image **sans dépendance npm**, basée sur `oven/bun:1-alpine`, exécutée en
**non-root**, ~132 Mo, avec un `HEALTHCHECK` sur `/health`.

```bash
docker build -t magileads-ai-server .
docker run -d --name magileads-ai -p 8787:8787 --env-file .env magileads-ai-server
# ou
docker compose up -d --build
```

### Sur Dokploy

**Option A — Application (recommandé)**

1. *Create Application* → source Git, puis définir ce dossier (`ai-server`) comme
   **Build Path / Docker Context** si le dépôt contient également l'application Next.
2. **Build Type : Dockerfile**.
3. **Environment** — renseigner :
   ```
   PORT=8787
   ALLOWED_ORIGINS=https://front.exemple.com
   RATE_LIMIT_PER_MIN=20
   MAGILEADS_API_BASE=https://app.api-magileads.net
   AI_API_URL=https://openrouter.ai/api/v1
   AI_API_KEY=sk-or-v1-...
   AI_MODEL=<modèle simple>
   AI_MODEL_COMPLEX=<modèle complexe>
   ```
4. **Domains** → ajouter le domaine (ex. `ai.magileads.com`), **Container Port
   `8787`**, HTTPS activé.
5. Déployer, puis vérifier : `curl https://ai.magileads.com/health` →
   `{"ok":true,"openrouter_available":true}` si OpenRouter est configuré.

**Option B — Compose** : *Create Compose*, pointer sur `docker-compose.yml` et
définir les variables dans l'onglet Environment. Le mapping `ports` peut être
retiré lorsque le proxy Dokploy est utilisé.

### Points d'attention

- **`ALLOWED_ORIGINS`** doit contenir l'origine EXACTE du front (`https://…`, sans
  slash final), faute de quoi le navigateur bloque la requête en CORS.
- **SSE derrière un proxy** : le serveur envoie déjà `X-Accel-Buffering: no` et
  `Cache-Control: no-transform`. Si la réponse arrive « d'un bloc », vérifier que
  le buffering est désactivé côté proxy.
- **Sessions longues** : le serveur envoie un commentaire SSE toutes les 15 s
  pendant les appels modèle et les outils. Le front ignore ces commentaires.
  Ces signaux évitent les coupures pour inactivité ; un proxy ou un fournisseur
  qui impose sa propre durée maximale doit être configuré séparément.
  Le bouton Stop et la déconnexion du client annulent toujours l’appel modèle.
- **Secrets** : `AI_API_KEY` reste côté serveur. Les clés OpenAI sont lues dans
  Magileads pour chaque appel et ne sont ni persistées ni journalisées par le
  serveur IA. Aucun volume de données n'est nécessaire.

---

## 8. Dépannage

### `401 Unauthorized` sur `POST /ai/chat`

Dans la grande majorité des cas, l'**access_token Magileads est expiré** (durée de
vie **30 minutes**). Le serveur valide le token via `GET /users/me` et relaie tel
quel le verdict de Magileads.

Diagnostic :

```bash
# 1) Le token est-il encore valide ? (source de vérité)
curl -s https://app.api-magileads.net/users/me -H "Authorization: Bearer $TOKEN"
#   -> {"state":false,"state_message":"token_expired"} = token expiré, pas un bug serveur

# 2) Le serveur répond-il ?
curl -s https://<domaine>/health          # -> {"ok":true,"configured":true}
```

Décoder l'expiration d'un token :

```bash
node -e "const p=JSON.parse(Buffer.from(process.argv[1].split('.')[1],'base64url'));\
console.log('expire:',new Date(p.exp*1000).toISOString(),'| maintenant:',new Date().toISOString())" "$TOKEN"
```

**Côté front**

- ❌ Ne **jamais coder en dur** un token pour un test : il expire en 30 minutes.
- ✅ Lire les en-têtes **au moment de l'envoi** (cf. `getAuthHeaders`, §5).
- ✅ Brancher `onAuthError` : sur un 401, le composant déclenche le refresh puis
  **rejoue automatiquement** la requête une fois, avec le token frais.

Autres codes : `403` = origine absente de `ALLOWED_ORIGINS` · `429` = rate limit ·
`412` = clé personnelle absente pour le compte · `503` = fournisseur ou stockage
des clés non configuré côté serveur.

---

## 9. Notes d'exploitation

### Capacités métier de l’assistant

Les outils de `src/business-actions.js` complètent le catalogue de fonctions :

- partage vers un utilisateur vérifié, sans effacer les accès existants : listes,
  séquences, modèles de tous les canaux, signatures, fichiers, agents IA, tags,
  champs, liens courts, blacklists, expéditeurs, pools, rapports, domaines Mailgun
  accessibles et filtres sauvegardés ;
- campagnes : séquence, statistiques (toujours en lecture) et prospects sont
  trois périmètres de partage distincts. Ne pas partager les expéditeurs ou tout
  le PRM sans demande explicite ;
- ajout manuel d’un contact avec résolution des vrais identifiants de champs ;
- lecture des filtres sauvegardés depuis `GET /users/me` et des rappels PRM ;
- exclusion des répondeurs au niveau de la séquence ou d’une action. Une nouvelle
  séquence utilise `auto_remove_responders:true` par défaut ; une action respecte
  cette règle avec `disable_auto_remove_responders:false`. Une branche de réponse
  incompatible est refusée, jamais corrigée en désactivant la règle en silence ;
- copie PRM → blacklist : propriétaire et filtres de page conservés, champs
  vérifiés, aperçu API puis `confirm_count` égal au compte recalculé. Aucun contact
  n’est supprimé ; un job accepté n’est pas relancé dans la même réponse ;
- programmation : `date_start` contient la date **et l’heure du lancement
  initial** dans `time_sending_timezone`. Les fenêtres quotidiennes
  `time_start_sending`/`time_stop_sending` sont indépendantes, tout comme les
  éventuelles fenêtres des étapes suivantes. Une modification partielle valide
  le planning existant sans renvoyer ni écraser ses autres paramètres.

`connect_email({account_id})` et `open_commercial_form({form:"import",list_id})`
retournent des cartes avec des IDs vérifiés, pas des secrets. Le frontend v5
réutilise ses formulaires d’import, d’upload et de reconnexion dans le chat.
Les fichiers sont envoyés directement à Magileads, jamais encodés dans le contexte
du modèle. Un upload dans la bibliothèque crée un lien public : le formulaire
le précise avant l’envoi.

Déployer le serveur IA **et** le frontend v5 pour ces nouvelles cartes. Aucune
nouvelle variable d’environnement n’est nécessaire. Les IDs optionnels restent
compatibles avec l’ancien protocole. Le serveur MCP autonome ChatGPT/Claude est
un autre dépôt et n’est pas modifié par ces changements.

Vérification sans données réelles : `node --test src/*.test.js`. Les tests métier
utilisent des réponses API fictives et vérifient les routes, les permissions,
les choix explicites, les filtres et l’absence de secrets dans les cartes.

L’affichage de la date programmée dans les tableaux et le classement des listes
dans l’onglet Audience sont des demandes UI indépendantes, hors de ces outils.
La demande de masquer des blocs de la fiche agent nécessite leur identification.

Les routes concernées sont détaillées dans
[`docs/assistant-business-endpoints.md`](docs/assistant-business-endpoints.md).

- **Modèle** : un modèle gratuit peut renvoyer `429` ou disparaître du catalogue
  (« No endpoints found »). En production, privilégier un modèle payant ou une clé
  BYOK. Le palier « Gratuit » bascule automatiquement sur le candidat suivant
  lorsqu'une liste est configurée.
- **Coût** : le rate-limit par utilisateur est stocké en mémoire ; avec plusieurs
  instances, le déporter vers un store partagé (Redis).
- **Scalabilité** : le serveur est quasi sans état (l'historique vit côté front),
  il se réplique donc derrière un load-balancer sans difficulté.
