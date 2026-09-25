# Assistant commercial v5

## Périmètre

Interface v5 et serveur autonome `D:/works/magileads-ai-server`. Aucun fichier du PRM modifié par ce chantier. Administration, facturation et gestion des accès hors périmètre, conformément au choix utilisateur.

Le serveur conserve les outils de lecture/ciblage existants et ajoute un catalogue explicite de 110 opérations commerciales, consulté avec `discover_operations` puis exécuté avec `run_operation`. Les imports et uploads passent par `open_commercial_form` ; la connexion email utilise `connect_email`. Les formulaires prennent le relais du chat. Ce n’est pas un proxy arbitraire vers toutes les routes de l’API.

## Comportement

- Fournisseur du modèle : OpenRouter reste le choix partagé par défaut. OpenAI utilise l'intégration déjà enregistrée dans le compte Magileads actif. Le serveur IA vérifie l'identité avec `/users/me`, lit `/external-api-keys` à chaque appel et utilise la clé OpenAI en mémoire pendant cet appel seulement. Il ne dispose d'aucun stockage de clés ou volume `/data`. Claude est visible mais désactivé tant que l'API Magileads ne prend pas en charge son intégration. Le palier « Gratuit » n'est proposé que pour OpenRouter : les appels OpenAI peuvent être facturés au propriétaire de la clé.

- Suppression retirée des outils et des consignes. Refus des anciens appels, des noms inconnus et des requêtes DELETE dans le client du serveur IA. Aucun bouton de confirmation de suppression métier dans v5. La suppression locale d’une conversation reste disponible.
- Connexion Google/Microsoft ou SMTP/IMAP via les composants Expéditeurs existants. Les mots de passe du formulaire ne sont pas transmis à la fonction de chat ni enregistrés dans son historique. OAuth conserve le parcours et les contrôles de marque blanche existants.
- Duplication : POST /contact-lists/{id}/copy, restitution du nouvel ID quand disponible.
- Dropcontact : seules les connexions de type dropcontact du compte sont proposées. Le modèle reçoit uniquement leur ID et nom. Vérification de la connexion avant lancement. Le résultat indique que le traitement a été accepté, jamais un enrichissement terminé sans preuve.
- Cartes v0 adaptées aux résultats réels : campagnes/KPI/bounces, listes/compteurs/actions, prospects, choix Dropcontact et fournisseurs email. Les valeurs absentes s’affichent « — ». Aucune reprise des faux contacts, scores et chiffres du prototype v0.
- ID des listes/campagnes/prospects sélectionnables directement ; workflow_id distingué de l’ID de campagne.
- Filtrage récursif des secrets avant transmission des résultats au modèle. Compteurs de mauvaises adresses de listes exclus ; bounces de campagne conservés.
- Invalidation des données en cache après les opérations du serveur. Les pages retrouvent les données fraîches à leur prochaine consultation.

## Contrat SSE

Les deltas de texte et linkedin.accounts existants sont conservés. Nouveaux événements :

- `assistant.card` : union validée côté front, kind = email, lists, campaigns, leads, connections, result ou form.
- `assistant.changed` : données à recharger après mutation.
- `assistant.error` : échec du flux, affiché comme erreur dans le chat.

Le serveur construit les cartes à partir des résultats d’outils, jamais à partir d’un marqueur inventé par le modèle. Les destinations des formulaires sont une liste fixe dans le front.

### Mode import de prospects

`POST /ai/chat` conserve `{messages:[{role,content}], tier, provider, openai_key_id?, model?}` et accepte en plus `mode?: "chat" | "import"` (défaut `"chat"`). Le front v5 envoie maintenant `mode:"import"` depuis la page d'import. Le serveur reconnaît toujours le préfixe `[Contexte : je suis sur la page de création de liste` pour les anciens clients. Le mode chat conserve ses outils et son comportement antérieurs. En mode import, le premier appel au modèle de chaque tour force `update_targeting`; les outils de mutation restent indisponibles avant un nouveau message utilisateur de validation explicite et tant que `ready_to_launch` est faux. Le serveur reprend le nom donné dans `La cible me convient : crée la liste « Nom »…` pour les anciens clients et n'essaie qu'un lancement par réponse.

Le bouton de validation v5 envoie aussi `import_approval?: {list_name:string} | {contact_list_id:number}` avec le dernier message utilisateur. Le serveur exige une conversation avec une réponse préalable de l'assistant, vérifie l'objet et impose cette destination aux arguments de tout outil `run_*`. `list_name` et `contact_list_id` sont mutuellement exclusifs ; le nom ne dépasse pas 80 caractères. Ainsi la traduction du texte du bouton ne change pas l'interprétation de la validation. La liste existante est vérifiée via `/contact-lists/{id}` avec le jeton de l'appelant. Le front bloque un second clic dans la même conversation ; une garantie d'idempotence entre appareils exigerait une clé d'idempotence persistée par l'API Magileads (ce serveur ne stocke pas les conversations).

`event: targeting.criteria` transporte **exactement** l'objet normalisé ci-dessous. Il vient de `update_targeting` (sans appel API) ; le serveur calcule `ready_to_launch` et `missing`. Cet outil n'émet ni `assistant.card` ni `assistant.changed`.

`event: targeting.count` transporte `{count:number}` après un `count_database_targeting` réussi. Le front attend ce comptage avant d'autoriser la validation d'une cible issue de la base Magileads, et attend le choix d'un compte LinkedIn pour les sources LinkedIn et Sales Navigator.

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
{"current_titles":["Directeur"],"locations":["105015875"],"industries":["4"],"current_companies":["Acme"],"company_head_counts":["51-200"],"seniority_levels":["director"]}
POST /targeting/linkedin/extract-sales-navigator-peoples-search[-alternative]
{"linkedin_sales_navigator_search_url":"https://www.linkedin.com/sales/search/people?...","linkedin_people_search_url":"https://www.linkedin.com/sales/search/people?...","linkedin_account_id":7,"generate_email":true,"max_results":100,"contact_list_name":"Prospects","contact_list_id":null,"contact_list_language":null,"contact_list_country":null,"exclude_viewed_leads":false,"exclude_crm_contacts":false}
POST /targeting/database/count-preview
{"filters":[{"field":"contact_location","contains":["Paris, France"]}]}
POST /targeting/database/extract
{"contact_list_name":"Prospects","contact_list_id":null,"max_results":100,"filters":[{"field":"contact_location","contains":["Paris, France"]}],"contact_list_country":null,"contact_list_language":"FRA"}
```

Pour alimenter une liste existante, les deux clés deviennent `"contact_list_name":null,"contact_list_id":123`. `locations` et `industries` de Sales Navigator sont des identifiants numériques encodés comme chaînes conformément au contrat de cet outil ; le Swagger public les déclare comme entiers, ce qui demande une vérification authentifiée avec l'API avant de conclure sur leur acceptation effective.

Chaque `run_*` réussi retourne `{status:"extraction lancée", list_id, list_name, criteria_applied, note}`. Les extractions Sales Navigator rapportent les filtres ignorés dans `criteria_applied.ignored_filters` et `note`. Les codes de secteur viennent du catalogue du sélecteur v4 ; effectifs et niveaux utilisent les valeurs exposées dans le Swagger Magileads. Pour chacun, le serveur compare l'URL obtenue avec et sans filtre avant de l'annoncer comme appliqué. Les événements existants restent inchangés : `tool.progress` avec `creates_list:true`, puis `assistant.card` `{kind:"lists", items:[{id,name}]}` sur succès, et `assistant.changed` pour invalider les données.

`SERVER_URL=... TOKEN=... node examples/import-smoke.mjs` imprime le flux réel sans lancer d'extraction. Définir en plus `VALIDATE_NAME="Nom"` envoie la validation et autorise une extraction réelle. Le script échoue si une carte de liste ou un progrès de création arrive avant validation.

Le Swagger public de `https://app.api-magileads.net/swagger.json` confirme les chemins, les champs `contact_list_id` des trois extractions, les schémas de filtres et les enums `CompanyHeadCount` / `SeniorityLevel`. Aucun appel authentifié aux endpoints de génération, comptage ou extraction n'a été effectué lors de cette implémentation ; l'acceptation effective des valeurs et les permissions d'un compte réel restent à vérifier avec un `TOKEN` de test. Les tests HTTP locaux simulent ces réponses et vérifient les payloads, les cartes et le blocage avant validation.

## Vérification et mise en service

- Serveur : `node --test src/*.test.js` (intégration OpenAI Magileads par compte, absence de stockage local, outils et flux HTTP).
- Front : `node scripts/test-assistant.mjs`, `npm run typecheck` et lint des fichiers Assistant.
- Tests navigateur : prototype v0 exécuté dans une copie temporaire (dépendances v5 ; analytics et import shadcn CSS indisponible retirés dans cette copie uniquement), audit affiché ; cartes v5 sur données fictives, clic Dupliquer, ouverture du formulaire SMTP. Les sources v0 sont intactes.
- Aucun envoi réel, enrichissement payant ou duplication sur un compte de production effectué. Le flux HTTP complet est testé contre un fournisseur et une API simulés ; les tests ne valident pas les droits/quota d’un compte réel ni toutes les réponses possibles de l’API.
- Le contrôle global i18n a signalé des clés manquantes dans les fichiers PRM modifiés parallèlement ; ce chantier ne les corrige pas.

**Déployer le serveur IA et le front ensemble.** Le front utilise AI_SERVER_URL et pointe par défaut sur https://magileads-ai-server.krypha.com. Modifier les fichiers locaux du serveur ne modifie pas ce service distant. En local, définir AI_SERVER_URL sur l’instance locale pour tester l’ensemble, puis utiliser un compte de test connecté. Les anciennes instances serveur n’émettent pas les nouvelles cartes et conservent leur ancienne politique de suppression.

Pour OpenAI, ajouter la clé dans **Magileads → Paramètres → Intégrations**. Le serveur IA ne requiert ni `AI_CREDENTIALS_KEY` ni volume persistant. `GET /ai/providers` permet au front de vérifier si le compte actif possède une intégration OpenAI ; les routes d'écriture de clés sur le serveur IA ont été retirées.

## Catalogue

La liste détaillée ci-dessous est issue du registre exécuté par le serveur.

### lists (19)

- duplicate_contact_list — POST /contact-lists/:id/copy
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
