# Groleads AI Server

Serveur **autonome** de l'assistant IA Groleads : même comportement que la route
`/api/ai/chat` de l'app Next.js, mais utilisable depuis **n'importe quel front**
(ton React JS, une autre app, un mobile…).

- **Zéro dépendance** — tourne avec **Bun** ou **Node 18+** (`node:http` + `fetch`).
- **Tout en JS** (ESM), pas de TypeScript.
- **Streaming SSE** : le texte arrive au fil de l'eau, comme ChatGPT.
- **Tool-calling** : 18 outils qui interrogent/agissent sur le compte Magileads
  **de l'utilisateur appelant**.

---

## 1. Le principe (important)

Le modèle **n'a aucune mémoire** : à chaque message, le serveur réassemble
`prompt système + historique + outils` et l'envoie au fournisseur (OpenRouter).

```
Front React ──(Bearer token Magileads)──► ai-server ──► modèle (OpenRouter)
                                             │              │
                                             │   « appelle list_campaigns »
                                             ▼
                                    Magileads API (avec le token DE L'UTILISATEUR)
                                             │
                                             └──► résultat ──► modèle ──► réponse (SSE)
```

**Sécurité** : le token de l'utilisateur sert **uniquement** à exécuter les outils
côté serveur. Il **n'entre jamais** dans le contexte du modèle — le modèle ne voit
que les *résultats*. Chaque utilisateur ne voit donc que **ses** données.

**Le serveur ne rafraîchit pas les tokens** : ton front le fait déjà (interceptor
axios + Web Locks). Si le token est expiré, le serveur répond `401` avec
`{ state_message: "token_expired" }` → ton front rafraîchit et retente.

---

## 2. Installation & lancement

```bash
cp .env.example .env     # puis renseigne AI_API_KEY / AI_MODEL
bun install              # (rien à installer, mais crée le lockfile)
bun run start            # → http://localhost:8787
```

Sans Bun :

```bash
npm run start:node       # node --env-file=.env src/server.js
```

### Variables d'environnement

| Variable             | Rôle                                                           |
| -------------------- | -------------------------------------------------------------- |
| `PORT`               | Port d'écoute (défaut `8787`)                                    |
| `ALLOWED_ORIGINS`    | Origines CORS autorisées, séparées par des virgules (`*` en dev) |
| `RATE_LIMIT_PER_MIN` | Requêtes max par utilisateur et par minute (défaut 20)           |
| `MAGILEADS_API_BASE` | `https://app.api-magileads.net`                                  |
| `AI_API_URL`         | Fournisseur compatible OpenAI (défaut OpenRouter)                |
| `AI_API_KEY`         | Clé du fournisseur (**serveur uniquement**)                      |
| `AI_MODEL`           | Modèle du palier « Simple »                                      |
| `AI_MODEL_COMPLEX`   | Modèle du palier « Complexe » (si vide → = Simple)               |

> ⚠️ Le modèle doit supporter le **function calling**.

---

## 3. API

### `POST /ai/chat` → flux SSE

**En-têtes**

```
Content-Type: application/json
Authorization: Bearer <access_token Magileads de l'utilisateur>
   (ou)  X-API-Key: <clé API Magileads>
```

**Corps**

```json
{
  "tier": "simple",
  "messages": [
    { "role": "user", "content": "Combien de campagnes ai-je ?" },
    { "role": "assistant", "content": "Tu as 2 campagnes." },
    { "role": "user", "content": "Et des listes ?" }
  ]
}
```

- `tier` : `"simple"` | `"complex"` — l'utilisateur ne voit jamais le nom du modèle.
- `messages` : tout l'historique (le modèle est sans mémoire). Seuls les rôles
  `user`/`assistant` sont acceptés (un client ne peut pas injecter de `system`).

**Réponse : `text/event-stream`**

| Événement                 | Charge utile                                                       | À quoi ça sert                       |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------ |
| *(sans event)*            | `{"choices":[{"delta":{"content":"…"}}]}`                            | morceau de texte à concaténer        |
| `event: tool.progress`    | `{tool,label,status:"running"\|"completed",creates_list}`            | indicateur « ⚙️ Lecture des listes… » |
| `event: linkedin.accounts`| `{accounts:[{id,name,username}]}`                                    | carte cliquable de choix de compte   |
| *(sans event)*            | `[DONE]`                                                             | fin du flux                          |

**Codes d'erreur** : `401` (token absent/expiré → rafraîchis et retente),
`429` (rate limit), `503` (`AI_API_KEY`/`AI_MODEL` non configurés), `400` (vide).

### `GET /health` → `{ ok, configured }`
### `GET /ai/meta` → `{ toolLabels, createsList }` (libellés FR pour l'indicateur)

---

## 4. Les marqueurs dans le texte

Deux conventions que le front doit gérer (le composant d'exemple le fait) :

1. **`[[CONFIRM_DELETE]]{...}[[/CONFIRM_DELETE]]`** — avant toute suppression,
   l'assistant émet ce marqueur avec le **nombre exact** de contacts. Le front
   affiche une **carte rouge** de confirmation ; tant que l'utilisateur n'a pas
   confirmé, rien n'est supprimé. *(Sécurité réelle : côté serveur, la suppression
   recompte et refuse si le nombre a changé, et un filtre vide est interdit.)*

2. **Carte de comptes LinkedIn** — elle est construite **par le serveur** à partir
   du vrai résultat d'outil (événement `linkedin.accounts`), **jamais** depuis le
   texte du modèle. Si le modèle tape quand même `[[PICK_ACCOUNT]]`, le front doit
   l'**ignorer/supprimer** (le composant d'exemple le fait) — c'est ce qui évite
   qu'un petit modèle **invente** un compte inexistant.

---

## 5. Intégration dans ton front React

```jsx
import AiAssistant from "./AiAssistant";              // examples/AiAssistant.jsx
import { useSessionStore } from "./stores/UserStore";
import { mainAxios } from "./api/axios";

export default function AiPage() {
  return (
    <AiAssistant
      serverUrl={import.meta.env.VITE_AI_SERVER_URL || "http://localhost:8787"}
      // Le vrai token de l'utilisateur connecté :
      getAccessToken={() => useSessionStore.getState().session?.access_token}
      // Sur 401 : on force ton interceptor à rafraîchir, puis le composant retente.
      onAuthError={async () => {
        try {
          await mainAxios.get("/users/me");           // déclenche le refresh + Web Lock
        } catch { /* l'interceptor gère la déconnexion */ }
      }}
    />
  );
}
```

Pense à ajouter l'origine de ton front dans `ALLOWED_ORIGINS`.

---

## 6. Les outils disponibles (18)

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

---

## 7. Déploiement (Docker / Dokploy)

Image **sans dépendance npm**, basée sur `oven/bun:1-alpine`, **non-root**, ~132 MB,
avec un `HEALTHCHECK` sur `/health`.

```bash
docker build -t groleads-ai-server .
docker run -d --name groleads-ai -p 8787:8787 --env-file .env groleads-ai-server
# ou
docker compose up -d --build
```

### Sur Dokploy

**Option A — Application (recommandé)**

1. *Create Application* → source Git → sélectionne ce dossier (`ai-server`) comme
   **Build Path / Docker Context** si le repo contient aussi l'app Next.
2. **Build Type : Dockerfile**.
3. **Environment** — colle :
   ```
   PORT=8787
   ALLOWED_ORIGINS=https://ton-front.exemple.com
   RATE_LIMIT_PER_MIN=20
   MAGILEADS_API_BASE=https://app.api-magileads.net
   AI_API_URL=https://openrouter.ai/api/v1
   AI_API_KEY=sk-or-v1-...
   AI_MODEL=<modèle simple>
   AI_MODEL_COMPLEX=<modèle complexe>
   ```
4. **Domains** → ajoute ton domaine (ex. `ai.groleads.com`), **Container Port
   `8787`**, HTTPS activé.
5. Deploy. Vérifie : `curl https://ai.groleads.com/health` → `{"ok":true,"configured":true}`.

**Option B — Compose** : *Create Compose*, pointe sur `docker-compose.yml` et
définis les variables dans l'onglet Environment (le mapping `ports` peut être
retiré si tu passes par le proxy Dokploy).

### Points d'attention

- **`ALLOWED_ORIGINS`** doit contenir l'origine EXACTE de ton front
  (`https://…`, sans slash final), sinon le navigateur bloque en CORS.
- **SSE derrière le proxy** : l'app envoie déjà `X-Accel-Buffering: no` et
  `Cache-Control: no-transform`. Si le streaming arrive « d'un bloc », vérifie que
  le buffering est désactivé côté proxy.
- **Timeout du proxy** : un audit peut durer > 60 s. Monte le timeout de réponse
  (Traefik/nginx) à ~180 s pour ne pas couper le flux.
- **Secrets** : `AI_API_KEY` reste côté serveur ; ne l'expose jamais au front.

---

## 8. Dépannage

### `401 Unauthorized` sur `POST /ai/chat`

Dans 99 % des cas : **l'access_token Magileads est expiré** (durée de vie
**30 minutes**). Le serveur valide le token via `GET /users/me` et relaie tel quel
le verdict de Magileads.

Diagnostic en 10 secondes :

```bash
# 1) Le token est-il encore vivant ? (source de vérité)
curl -s https://app.api-magileads.net/users/me -H "Authorization: Bearer $TOKEN"
#   -> {"state":false,"state_message":"token_expired"}  = token mort, pas un bug serveur

# 2) Le serveur est-il debout ?
curl -s https://<ton-domaine>/health          # -> {"ok":true,"configured":true}
```

Décoder l'expiration d'un token :

```bash
node -e "const p=JSON.parse(Buffer.from(process.argv[1].split('.')[1],'base64url'));\
console.log('expire:',new Date(p.exp*1000).toISOString(),'| maintenant:',new Date().toISOString())" "$TOKEN"
```

**Corriger côté front** (à ne surtout pas rater) :

- ❌ Ne **jamais coder en dur** un token pour tester : il meurt en 30 min.
- ✅ Lire le token **au moment de l'envoi** :
  `getAccessToken={() => useSessionStore.getState().session?.access_token}`
- ✅ Brancher `onAuthError` (cf. §5) : sur 401 le composant appelle ton refresh
  puis **retente automatiquement une fois** avec le token frais.

Autres codes : `403` = origine absente de `ALLOWED_ORIGINS` · `429` = rate limit ·
`503` = `AI_API_KEY`/`AI_MODEL` manquants côté serveur.

---

## 9. Notes d'exploitation

- **Modèle** : un modèle gratuit peut tomber en `429` ou disparaître
  (« No endpoints found ») — pour la prod, prends un modèle payant / ta clé BYOK.
- **Coût** : le rate-limit par utilisateur est en mémoire ; avec plusieurs
  instances, passe sur un store partagé (Redis).
- **Scalabilité** : le serveur est quasi sans état (l'historique vit dans le front)
  → il se réplique derrière un load-balancer sans difficulté.
