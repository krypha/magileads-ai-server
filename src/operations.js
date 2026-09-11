import { request } from './magileads.js';
import { forbiddenOperation, hasSecret, sanitize } from './assistant-policy.js';

// Explicit routes only. The model never chooses a URL, HTTP verb, or headers.
// Bodies use the same names as v5/src/lib/api and v4/src/api/ContactAPI.js.
const operations = [];
function add(name, group, method, path, fields = [], required = [], description = '') {
  operations.push({ name, group, method, path, fields, required, description });
}
add('duplicate_contact_list', 'lists', 'POST', '/contact-lists/:id/copy', [], [], 'Dupliquer intégralement une liste. Renvoie contact_list_id.');
add('enrich_dropcontact', 'lists', 'POST', '/contact-lists/:id/enrich/external/dropcontact/:key_id', ['filter'], [], 'Lancer un enrichissement asynchrone Dropcontact ; utilise uniquement un ID de clé de list_dropcontact_connections. Peut consommer des crédits.');
add('create_contact_list', 'lists', 'POST', '/contact-lists', ['name', 'folder_id', 'tags_ids'], ['name']);
add('update_contact_list', 'lists', 'PUT', '/contact-lists/:id', ['name', 'folder_id', 'tags_ids', 'language', 'country', 'pin']);
add('split_contact_list', 'lists', 'POST', '/contact-lists/:id/split', ['number_lists'], ['number_lists']);
add('copy_list_to_prm', 'lists', 'POST', '/contact-lists/:id/copy/prm', ['status', 'custom_status', 'contacts_selection'], ['status']);
add('enrich_contact_list', 'lists', 'POST', '/contact-lists/:id/enrich', ['generate_email', 'filter', 'contact_ids', 'excluded_contact_ids'], ['generate_email']);
add('verify_list_emails', 'lists', 'POST', '/contact-lists/:id/email-verifier');
add('translate_contact_list', 'lists', 'POST', '/contact-lists/:id/translate', ['language'], ['language']);
add('resolve_linkedin_urls', 'lists', 'POST', '/contact-lists/:id/enrich/linkedin/url');
add('create_contact', 'lists', 'POST', '/contact-lists/:id/contact', ['properties'], ['properties']);
add('update_contact', 'lists', 'PUT', '/contact-lists/:id/contacts/:contact_id', ['properties'], ['properties']);
add('list_workflows', 'campaigns', 'GET', '/workflows');
add('create_workflow', 'campaigns', 'POST', '/workflows', ['name', 'steps', 'tags_ids', 'folder_id', 'nurturing', 'is_newsletter'], ['name', 'steps']);
add('update_workflow', 'campaigns', 'PUT', '/workflows/:id', ['name', 'steps', 'tags_ids', 'folder_id', 'nurturing', 'is_newsletter']);
add('duplicate_workflow', 'campaigns', 'POST', '/workflows/:id/copy');
add('pause_campaign', 'campaigns', 'PUT', '/workflows/:workflow_id/programmation/:id/stop');
add('resume_campaign', 'campaigns', 'PUT', '/workflows/:workflow_id/programmation/:id/resume');
add('archive_campaign', 'campaigns', 'PUT', '/workflows/:workflow_id/programmation/:id/archive');
add('unarchive_campaign', 'campaigns', 'PUT', '/workflows/:workflow_id/programmation/:id/unarchive');
add('get_global_reporting', 'reporting', 'GET', '/statistics/global');
for (const [name, path] of [['get_period_reporting', '/statistics/global/detailed'], ['get_daily_reporting', '/statistics/date/detailed']]) {
  add(name, 'reporting', 'POST', path, ['date_range', 'limit_to_programmation_ids', 'limit_to_integration_ids'], ['date_range']);
}
for (const [channel, path] of Object.entries({ email: '/models/email', linkedin_message: '/models/linkedin/message', linkedin_invitation: '/models/linkedin/invitation', sms: '/models/sms', vms: '/models/smv', signature: '/email-signatures' })) {
  const fields = ['name', 'subject', 'text', 'html', 'json_template', 'file_id', 'is_template', 'tags_ids', 'folder_id'];
  add(`list_${channel}_models`, 'models', 'GET', path);
  add(`get_${channel}_model`, 'models', 'GET', `${path}/:id`);
  add(`create_${channel}_model`, 'models', 'POST', path, fields, ['name']);
  add(`update_${channel}_model`, 'models', 'PUT', `${path}/:id`, fields);
}
for (const [name, path, fields] of [['tag', '/tags', ['name', 'color']], ['folder', '/folders', ['name', 'type', 'parent_id']], ['data_field', '/data-fields', ['name', 'possible_values']]]) {
  add(`list_${name}s`, 'organization', 'GET', path);
  add(`create_${name}`, 'organization', 'POST', path, fields, ['name', ...(name === 'folder' ? ['type'] : [])]);
  add(`update_${name}`, 'organization', 'PUT', `${path}/:id`, name === 'folder' ? ['name'] : fields);
}
add('list_ai_agents', 'agents', 'GET', '/ai-agents');
add('get_ai_agent', 'agents', 'GET', '/ai-agents/:uniqid');
const agentFields = ['name', 'activity_description', 'website_url', 'brief', 'bio', 'tone', 'additional_instructions', 'gender', 'spoken_language', 'avatar', 'targets', 'value_propositions', 'main_objective', 'objective_link', 'objective_link_type', 'integration_id', 'linkedin_integration_id', 'email_signature_id', 'referent_name', 'referent_integration_id', 'active'];
add('create_ai_agent', 'agents', 'POST', '/ai-agents', agentFields, ['name']);
add('update_ai_agent', 'agents', 'PUT', '/ai-agents/:uniqid', agentFields);
add('generate_agent_brief', 'agents', 'POST', '/ai-agents/generate-brief', ['website_url', 'activity_description']);
add('list_email_accounts', 'senders', 'GET', '/integrations/email');
add('list_sender_pools', 'senders', 'GET', '/pools');
add('get_sender_pool', 'senders', 'GET', '/pools/:id');
add('relaunch_linkedin_errors', 'targeting', 'POST', '/targeting/linkedin/:id/relaunch-errors', ['linkedin_account_id'], ['linkedin_account_id']);
add('refresh_linkedin_targeting', 'targeting', 'POST', '/targeting/linkedin/refresh/:id', ['linkedin_account_id'], ['linkedin_account_id']);
add('relaunch_google_targeting', 'targeting', 'POST', '/targeting/google/extract-maps-search/:id/relaunch');

const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const scheduleRequired = ['date_start', 'daily_send_limit', ...weekdays.map(day => `allowed_${day}`), 'priority_email', 'time_start_sending', 'time_stop_sending', 'limit_total_sending', 'copy_prospect_if_scoring_above', 'blacklist_ids', 'exclude_programmation_ids'];
const scheduleFields = [...scheduleRequired, 'contactlist_ids', 'date_stop', 'stop_steps_at_end_date', 'time_sending_timezone', 'resend_to_bounce', 'ab_proportion', 'ab_subject_2', 'ab_subject_3', ...weekdays.flatMap(day => [`time_start_sending_${day}`, `time_stop_sending_${day}`])];
add('schedule_campaign', 'campaigns', 'POST', '/workflows/:workflow_id/program', scheduleFields, [...scheduleRequired, 'contactlist_ids', 'time_sending_timezone'], 'Programme un envoi réel. Recueillir la liste, les expéditeurs, les dates, le fuseau et les limites avant de lancer. Les jours sont des booléens ; dates YYYY-MM-DD, heures HH:MM:SS.');
add('get_campaign_schedule', 'campaigns', 'GET', '/workflows/:workflow_id/programmation/:id');
add('update_campaign_schedule', 'campaigns', 'PUT', '/workflows/:workflow_id/programmation/:id', scheduleFields, [], 'Lire le planning existant avant modification et conserver les autres paramètres.');
add('pause_campaign_step', 'campaigns', 'PUT', '/workflows/:workflow_id/programmation/:id/step/:step_id/stop');
add('resume_campaign_step', 'campaigns', 'PUT', '/workflows/:workflow_id/programmation/:id/step/:step_id/resume');
add('create_sender_pool', 'senders', 'POST', '/pools', ['name', 'type'], ['name', 'type']);
add('add_account_to_pool', 'senders', 'POST', '/pools/:id/:account_id');
add('get_email_account', 'senders', 'GET', '/integrations/email/:id');
add('list_short_links', 'organization', 'GET', '/urls-shortener');
add('create_short_link', 'organization', 'POST', '/urls-shortener', ['name', 'url'], ['name', 'url']);
add('update_short_link', 'organization', 'PUT', '/urls-shortener/:id', ['name', 'url'], ['name', 'url']);
add('get_folder', 'organization', 'GET', '/folders/:id');
add('update_prm_contact', 'prm', 'PUT', '/prm/contact/:id', ['properties', 'status', 'custom_status', 'is_positive', 'score', 'amount', 'probability', 'closing_date', 'person_in_charge', 'tags_ids', 'new_reply', 'new_first_reply']);
add('move_prm_contacts', 'prm', 'PUT', '/prm/contacts/status', ['user_id', 'contacts_selection', 'status', 'custom_status'], ['user_id', 'contacts_selection']);
add('copy_prm_to_list', 'prm', 'POST', '/prm/contacts/contact-list/:id/add', ['user_id', 'contacts_selection'], ['user_id', 'contacts_selection']);
add('set_prm_new_reply', 'prm', 'PUT', '/prm/contacts/new_reply', ['user_id', 'contacts_selection', 'new_reply'], ['user_id', 'contacts_selection', 'new_reply']);
add('tag_prm_contacts', 'prm', 'POST', '/prm/contacts/user/:user_id/tags', ['tag_ids', 'contact_ids', 'filter', 'excluded_contact_ids'], ['tag_ids', 'contact_ids', 'filter', 'excluded_contact_ids']);
add('enrich_prm_mobile', 'prm', 'POST', '/prm/contact/:id/enrich/phone/mobile');
add('list_crons', 'automation', 'GET', '/crons');
add('get_cron', 'automation', 'GET', '/crons/:id');
add('list_zapier_hooks', 'automation', 'GET', '/zapier');
add('get_zapier_hook', 'automation', 'GET', '/zapier/:id');
add('activate_zapier_hook', 'automation', 'PUT', '/zapier/:id/activate');
add('deactivate_zapier_hook', 'automation', 'PUT', '/zapier/:id/deactivate');
add('list_webhooks', 'automation', 'GET', '/webhooks');
add('get_webhook', 'automation', 'GET', '/webhooks/:id');
add('send_email', 'messages', 'POST', '/workflows/send/email', ['email_account_id', 'recipients', 'cc_recipients', 'subject', 'html', 'text', 'email_signature_id', 'reply_id', 'programmation_contact_id', 'contact_id_prm'], ['email_account_id', 'recipients', 'subject', 'html'], 'Envoi immédiat. Le destinataire, le compte expéditeur et le contenu doivent être explicitement demandés ou validés par l’utilisateur. Ne jamais envoyer simplement pour tester.');
add('send_linkedin_message', 'messages', 'POST', '/prm/contact/:id/linkedin/message', ['integration_id', 'message', 'file_id'], ['integration_id', 'message'], 'Envoi immédiat au prospect sélectionné, uniquement à la demande explicite de l’utilisateur.');
add('send_linkedin_invitation', 'messages', 'POST', '/prm/contact/:id/linkedin/invitation', ['integration_id', 'message'], ['integration_id', 'message'], 'Invitation LinkedIn, uniquement à la demande explicite de l’utilisateur.');
add('create_prm_note', 'prm', 'POST', '/prm/contact/:id/note', ['note'], ['note']);
add('update_prm_note', 'prm', 'PUT', '/prm/contact/:id/note/:note_id', ['note'], ['note']);
add('create_prm_reminder', 'prm', 'POST', '/prm/contact/:id/call', ['name', 'call_date', 'type'], ['name', 'call_date']);
add('create_prm_status', 'prm', 'POST', '/prm/status/custom', ['name'], ['name']);
add('update_prm_status', 'prm', 'PUT', '/prm/status/custom/:id', ['name', 'visible', 'color', 'sorting']);
add('list_blacklists', 'lists', 'GET', '/blacklists');
add('get_blacklist', 'lists', 'GET', '/blacklists/:id');
add('create_blacklist', 'lists', 'POST', '/blacklists', ['name', 'contains_match'], ['name']);
add('update_blacklist', 'lists', 'PUT', '/blacklists/:id', ['name', 'contains_match']);
add('add_blacklist_entries', 'lists', 'POST', '/blacklists/:id/data', ['data', 'ignore_errors'], ['data']);
add('list_unsubscribers', 'lists', 'GET', '/unsubscribers');
add('add_unsubscribers', 'lists', 'POST', '/unsubscribers/', ['organization_id', 'data'], ['data']);
add('list_files', 'models', 'GET', '/files');
add('get_file', 'models', 'GET', '/files/:id');

export const OPERATIONS = Object.freeze(operations);
const object = { type: 'object' };
export const EXTENDED_TOOLS = [
  ['discover_operations', 'Découvrir les fonctions disponibles et les champs acceptés. Filtrer par groupe lists, campaigns, reporting, models, organization, agents, senders, targeting, prm, messages ou automation.', { group: { type: 'string' } }, []],
  ['run_operation', 'Exécuter une fonction du catalogue obtenu par discover_operations. Aucune suppression. Pour les créations/modifications utiliser uniquement les valeurs demandées par l’utilisateur.', { operation: { type: 'string' }, params: object, body: object }, ['operation']],
  ['connect_email', 'Afficher dans le chat le formulaire sécurisé de connexion email. Ne jamais demander de mot de passe dans le chat.', {}, []],
  ['open_commercial_form', 'Ouvrir le formulaire commercial pour les imports/uploads de fichiers, la création visuelle de campagne/modèle ou les réglages avancés des expéditeurs. Le formulaire prend le relais ; ne pas prétendre avoir terminé l’action.', { form: { type: 'string', enum: ['import', 'files', 'campaign', 'models', 'senders'] } }, ['form']],
  ['list_dropcontact_connections', 'Lister les connexions Dropcontact disponibles (identifiants et noms uniquement, jamais les secrets).', {}, []],
].map(([name, description, properties, required]) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } }));

export async function executeExtended(name, args, auth) {
  if (name === 'open_commercial_form') return ['import', 'files', 'campaign', 'models', 'senders'].includes(args.form) ? { ui: 'form', form: args.form, status: 'awaiting_user' } : { error: 'unknown_form' };
  if (name === 'connect_email') return { ui: 'connect_email', status: 'awaiting_user', note: 'Le formulaire crée le compte directement auprès de Magileads. Aucun mot de passe ne passe par ce serveur IA.' };
  if (name === 'discover_operations') return { operations: OPERATIONS.filter(op => !args.group || op.group === args.group).map(({ method, path, ...op }) => ({ ...op, params: [...path.matchAll(/:([a-z_]+)/g)].map(match => match[1]) })) };
  if (name === 'list_dropcontact_connections') {
    const r = await request('/external-api-keys', { auth });
    return r.ok ? { connections: (r.data?.external_api_keys_list ?? []).filter(key => key.type === 'dropcontact').map(key => ({ id: key.id, name: key.name })) } : { error: r.errorKey || 'connections_unavailable' };
  }
  if (name !== 'run_operation') return null;
  const op = OPERATIONS.find(item => item.name === args.operation);
  if (!op || forbiddenOperation(args.operation)) return { error: 'operation_not_allowed' };
  const params = args.params ?? {}, body = args.body ?? {};
  if (hasSecret(args) || !body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid_arguments' };
  if (Object.keys(body).some(key => !op.fields.includes(key)) || op.required.some(key => body[key] === undefined)) return { error: 'invalid_body', allowed: op.fields, required: op.required };
  let valid = true;
  const path = op.path.replace(/:([a-z_]+)/g, (_, key) => {
    const value = String(params[key] ?? '');
    if (!(key === 'uniqid' ? /^[a-zA-Z0-9_-]+$/.test(value) : /^[1-9]\d*$/.test(value))) valid = false;
    return encodeURIComponent(value);
  });
  if (!valid) return { error: 'invalid_resource_id' };
  if (op.name === 'schedule_campaign') {
    if (!Array.isArray(body.contactlist_ids) || !body.contactlist_ids.length || !weekdays.some(day => body[`allowed_${day}`] === true) || body.time_stop_sending <= body.time_start_sending || (body.date_stop && body.date_stop < body.date_start)) return { error: 'invalid_schedule' };
  }
  if (op.name === 'enrich_dropcontact') {
    const keys = await executeExtended('list_dropcontact_connections', {}, auth);
    if (!keys.connections?.some(key => String(key.id) === String(params.key_id))) return { error: 'dropcontact_connection_not_found' };
  }
  const payload = op.name === 'enrich_dropcontact' ? { filter: { mode: 'and', values: [] }, ...body } : op.name === 'create_ai_agent' ? { description: '', rules: [], sharing: [], tags_ids: [], active: true, ...body } : body;
  const r = await request(path, { auth, method: op.method, ...(op.method !== 'GET' ? { body: Object.keys(payload).length ? payload : undefined } : {}) });
  if (!r.ok) return { error: r.errorKey || 'operation_failed', status: r.status };
  return { operation: op.name, status: 'accepted', data: sanitize(r.data), resource_id: params.id };
}
