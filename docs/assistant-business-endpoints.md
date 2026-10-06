# Assistant intégré : routes métier ajoutées ou corrigées

Les permissions ci-dessous décrivent l’effet métier, pas un scope OAuth du MCP
autonome. Le serveur IA transmet l’identité du compte actif ; l’API reste
l’autorité pour la propriété et les droits. Aucune route DELETE n’est ajoutée.

| Action | Méthode et route | Permission |
| --- | --- | --- |
| Filtres sauvegardés | `GET /users/me` | read |
| Partager un filtre sauvegardé | `GET /users/me`, `PUT /users/me` (`saved_filters`) | read + write |
| Destinataires de partage | `GET /users/list`, `POST /users/list/search` | read (POST de recherche) |
| Contact manuel | `GET /contact-lists/{id}`, `GET /data-fields`, `POST /contact-lists/{id}/contact` | read + write |
| Créer une séquence | `POST /workflows` (`auto_remove_responders`, `steps`) | write |
| Exclusion des répondeurs | `GET /workflows/{id}`, `PUT /workflows/{id}` | read + write |
| Programmer une campagne | `POST /workflows/{workflow_id}/program` | write |
| Modifier le planning | `GET`, `PUT /workflows/{workflow_id}/programmation/{id}` | read + write |
| Rappels du prospect | `GET /prm/contact/{id}` sans `set_new_reply_read` | read |
| Aperçu blacklist PRM | `GET /users/me` si profil non disponible, `GET /prm/list`, `GET /prm/status`, `GET /prm/status/custom` selon la colonne, `GET /data-fields` pour le PRM propre, `GET /blacklists/{id}`, `GET /prm/contacts/user/{user_id}?options=…` | read |
| Copier PRM → blacklist | `POST /prm/contacts/user/{user_id}/copy/blacklist/{blacklist_id}` | write |
| Vérifier une reconnexion | `GET /integrations/email/{id}` | read |
| Reconnexion dans le formulaire frontend | `GET /integrations/email/{id}`, puis OAuth via `auth_url` existante ou `PUT /integrations/email/{type}/{id}` (`connection_test` ou paramètres du formulaire sécurisé) | read + write |
| Import CSV/XLSX dans le formulaire frontend | `GET /data-fields`, `GET /contact-lists/names`, `POST /contact-lists` si destination nouvelle, `POST /contact-lists/{id}/contacts` multipart (`contacts`: JSON de propriétés, `ignore_errors`) | read + write |
| Upload dans le formulaire frontend | `POST /files` multipart | write |

## Partager une ressource

Chaque partage relit d’abord la ressource et ses accès, vérifie le destinataire,
puis ajoute un accès utilisateur en lecture par défaut. Les droits des autres
destinataires sont préservés ; les droits hérités ne sont pas dupliqués.

| Ressource (`kind`) | Lecture | Écriture |
| --- | --- | --- |
| `contact_list` | `GET /contact-lists/{id}` | `PUT /contact-lists/{id}` |
| `workflow` | `GET /workflows/{id}` | `PUT /workflows/{id}` |
| `email_model` | `GET /models/email/{id}` | `PUT /models/email/{id}` |
| `linkedin_message_model` | `GET /models/linkedin/message/{id}` | `PUT /models/linkedin/message/{id}` |
| `linkedin_invitation_model` | `GET /models/linkedin/invitation/{id}` | `PUT /models/linkedin/invitation/{id}` |
| `sms_model` | `GET /models/sms/{id}` | `PUT /models/sms/{id}` |
| `voice_model` | `GET /models/smv/{id}` | `POST /models/smv/{id}` multipart |
| `email_signature` | `GET /email-signatures/{id}` | `PUT /email-signatures/{id}` |
| `tag` | `GET /tags/{id}` | `PUT /tags/{id}` |
| `data_field` | `GET /data-fields/{id}` | `PUT /data-fields/{id}` |
| `short_link` | `GET /urls-shortener/{id}` | `PUT /urls-shortener/{id}` |
| `blacklist` | `GET /blacklists/{id}` | `PUT /blacklists/{id}` |
| `file` | `GET /files/{id}` | `POST /files/{id}` multipart |
| `pool` | `GET /pools/{id}` | `PUT /pools/{id}` |
| `ai_agent` | `GET /ai-agents/{uniqid}` | `PUT /ai-agents/{uniqid}` |
| `linkedin_account` | `GET /integrations/linkedin/{id}` | `PUT /integrations/linkedin/{id}` |
| `email_account` | `GET /integrations/email/{id}` | `PUT /integrations/email/{smtp,gmail,outlook,mass-mailing}/{id}` selon le type lu |
| `report` | `GET /reporting/report/{id}` | `PUT /reporting/report/{id}` |
| `mailgun_domain` | `GET /resellers/{reseller_id}/mailgun/domains/{id}` | `POST /resellers/{reseller_id}/mailgun/domains/{id}` |
| `campaign_statistics` | `GET /workflows/{workflow_id}/programmation/{id}` | `PUT` même route, `stats_sharings` en lecture seule |
| `campaign_prospects` | `GET /statistics/programmations/{id}` | `POST /prm/sharings`, filtre `programmation_id equals {id}` |
| `prm_contact` | `GET /prm/contact/{id}` | `POST /prm/sharings`, filtre `id equals {id}` |
| `prm` | destinataire vérifié, filtre validé | `POST /prm/sharings`, filtre demandé ; tout le PRM exige `entire_prm:true` |
| `saved_filter` | `GET /users/me` | `PUT /users/me`, préservation des filtres propres sur toutes les pages |

Les routes et les schémas ont été vérifiés avec le frontend et
[l’OpenAPI Magileads](https://api.magileads.net/swagger.json). Les tests utilisent
des fixtures ; ils ne constituent pas une validation de toutes les permissions
sur les comptes de production.
