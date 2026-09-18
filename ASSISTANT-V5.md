# Assistant commercial v5

## Périmètre

Interface v5 et serveur autonome `D:/works/magileads-ai-server`. Aucun fichier du PRM modifié par ce chantier. Administration, facturation et gestion des accès hors périmètre, conformément au choix utilisateur.

Le serveur conserve les outils de lecture/ciblage existants et ajoute un catalogue explicite de 110 opérations commerciales, consulté avec `discover_operations` puis exécuté avec `run_operation`. Les imports et uploads passent par `open_commercial_form` ; la connexion email utilise `connect_email`. Les formulaires prennent le relais du chat. Ce n’est pas un proxy arbitraire vers toutes les routes de l’API.

## Comportement

- Fournisseur du modèle : OpenRouter reste le choix partagé par défaut ; OpenAI et Claude utilisent une clé API propre au compte Magileads, saisie dans le sélecteur de l'assistant. Le secret n'entre ni dans le chat, ni dans son historique local, ni dans Zustand. Le serveur IA le chiffre avec AES-256-GCM et le rattache à l'identité vérifiée par `/users/me`. Claude utilise l'API Messages native et conserve les outils/cartes du chat. Le palier « Gratuit » n'est proposé que pour OpenRouter : les API directes peuvent facturer les appels au propriétaire de la clé.

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

## Vérification et mise en service

- Serveur : `node --test src/*.test.js` (clés chiffrées, isolation entre comptes, OpenAI, Claude natif, outils et flux HTTP).
- Front : `node scripts/test-assistant.mjs`, `npm run typecheck` et lint des fichiers Assistant.
- Tests navigateur : prototype v0 exécuté dans une copie temporaire (dépendances v5 ; analytics et import shadcn CSS indisponible retirés dans cette copie uniquement), audit affiché ; cartes v5 sur données fictives, clic Dupliquer, ouverture du formulaire SMTP. Les sources v0 sont intactes.
- Aucun envoi réel, enrichissement payant ou duplication sur un compte de production effectué. Le flux HTTP complet est testé contre un fournisseur et une API simulés ; les tests ne valident pas les droits/quota d’un compte réel ni toutes les réponses possibles de l’API.
- Le contrôle global i18n a signalé des clés manquantes dans les fichiers PRM modifiés parallèlement ; ce chantier ne les corrige pas.

**Déployer le serveur IA et le front ensemble.** Le front utilise AI_SERVER_URL et pointe par défaut sur https://magileads-ai-server.krypha.com. Modifier les fichiers locaux du serveur ne modifie pas ce service distant. En local, définir AI_SERVER_URL sur l’instance locale pour tester l’ensemble, puis utiliser un compte de test connecté. Les anciennes instances serveur n’émettent pas les nouvelles cartes et conservent leur ancienne politique de suppression.

Pour les clés OpenAI/Claude, configurer `AI_CREDENTIALS_KEY` (32 octets hex/base64) sur le serveur et conserver `/data/provider-keys.json` sur un volume persistant. Sans ces deux paramètres, OpenRouter fonctionne mais l'ajout de clés par compte est indisponible. La même clé maître doit être conservée entre déploiements ; la rotation nécessite de ressaisir les clés. Une seule instance peut écrire dans ce fichier ; plusieurs réplicas nécessitent un magasin partagé transactionnel.

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
