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
`prompt système + historique + outils` et l'envoie au fournisseur (OpenRouter).

```
Front ──(token Magileads)──► ai-server ──► modèle (OpenRouter)
                                 │              │
                                 │   « appeler list_campaigns »
                                 ▼
                        API Magileads (avec le token DE L'UTILISATEUR)
                                 │
                                 └──► résultat ──► modèle ──► réponse (SSE)
```

**Sécurité** : le token de l'utilisateur sert **uniquement** à exécuter les outils
côté serveur. Il **n'entre jamais** dans le contexte du modèle, qui ne reçoit que
les *résultats*. Chaque utilisateur n'accède donc qu'à **ses** données.

**Le serveur ne rafraîchit pas les tokens** : le front s'en charge déjà
(interceptor axios + Web Locks). Lorsqu'un token est expiré, le serveur répond
`401` avec `{ state_message: "token_expired" }`, à charge du client de rafraîchir
et de rejouer la requête.

---

## 2. Installation et lancement

```bash
cp .env.example .env     # renseigner AI_API_KEY et les modèles
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
| `MAGILEADS_API_BASE` | `https://app.api-magileads.net`                                     |
| `AI_API_URL`         | Fournisseur compatible OpenAI (défaut OpenRouter)                   |
| `AI_API_KEY`         | Clé du fournisseur (**serveur uniquement**)                         |
| `AI_MODEL_FREE`      | Palier « Gratuit » — défaut `openrouter/free` (routeur géré par OpenRouter). Accepte aussi une liste séparée par des virgules, essayée dans l'ordre |
| `AI_MODEL`           | Modèle du palier « Simple » (palier par défaut)                     |
| `AI_MODEL_COMPLEX`   | Modèle du palier « Complexe » (si vide → identique à Simple)        |
| `ALLOW_CUSTOM_MODEL` | `false` pour désactiver le palier « Perso. »                         |

> ⚠️ Le modèle doit supporter le **function calling**.

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
- `model` : **uniquement** avec `tier: "custom"` — identifiant du modèle (ex.
  `stealth/ox-alpha`). Format validé côté serveur (`editeur/modele`) ; sinon
  `400 invalid_custom_model`.
- `messages` : l'historique complet (le modèle est sans mémoire). Seuls les rôles
  `user` et `assistant` sont acceptés — un client ne peut pas injecter de `system`.

**Paliers de modèle**

| Palier | Modèle utilisé | Particularité |
| ------ | -------------- | ------------- |
| `free` | `AI_MODEL_FREE` (défaut `openrouter/free`) | OpenRouter sélectionne lui-même un modèle gratuit. Si une liste est épinglée, **bascule automatique** sur le suivant en cas de 429/404/402 |
| `simple` | `AI_MODEL` | palier par défaut |
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
`429` (rate limit), `503` (`AI_API_KEY` non configurée), `400` (corps vide ou
modèle personnalisé invalide).

### `GET /health` → `{ ok, configured }`
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
   `{"ok":true,"configured":true}`.

**Option B — Compose** : *Create Compose*, pointer sur `docker-compose.yml` et
définir les variables dans l'onglet Environment. Le mapping `ports` peut être
retiré lorsque le proxy Dokploy est utilisé.

### Points d'attention

- **`ALLOWED_ORIGINS`** doit contenir l'origine EXACTE du front (`https://…`, sans
  slash final), faute de quoi le navigateur bloque la requête en CORS.
- **SSE derrière un proxy** : le serveur envoie déjà `X-Accel-Buffering: no` et
  `Cache-Control: no-transform`. Si la réponse arrive « d'un bloc », vérifier que
  le buffering est désactivé côté proxy.
- **Timeout du proxy** : un audit peut dépasser 60 s. Porter le timeout de réponse
  (Traefik/nginx) à ~180 s pour ne pas interrompre le flux.
- **Secrets** : `AI_API_KEY` reste côté serveur et ne doit jamais être exposée au
  front.

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
`503` = `AI_API_KEY` manquante côté serveur.

---

## 9. Notes d'exploitation

- **Modèle** : un modèle gratuit peut renvoyer `429` ou disparaître du catalogue
  (« No endpoints found »). En production, privilégier un modèle payant ou une clé
  BYOK. Le palier « Gratuit » bascule automatiquement sur le candidat suivant
  lorsqu'une liste est configurée.
- **Coût** : le rate-limit par utilisateur est stocké en mémoire ; avec plusieurs
  instances, le déporter vers un store partagé (Redis).
- **Scalabilité** : le serveur est quasi sans état (l'historique vit côté front),
  il se réplique donc derrière un load-balancer sans difficulté.
