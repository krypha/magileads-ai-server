import { request } from './magileads.js';
import { hasSecret, sanitize } from './assistant-policy.js';
import { validPrmFilter } from './prm.js';

const id = value => (typeof value === 'number' || typeof value === 'string' && /^[1-9]\d*$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const failure = r => ({ error: r.errorKey || 'api_request_failed', status: r.status });
export const FILTER_PAGES = ['prm','blacklists','contact_lists','contact_lists_contacts','unsubscribers','users','files','models_email','models_linkedin_invitation','models_linkedin_message','models_sms','models_smv','integrations_email','integrations_linkedin','workflows','statistics'];
const weekdays = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
const time = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value);
const date = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:[ T](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)?$/.test(value)) return false;
  const day = value.slice(0,10);
  try { return new Date(day).toISOString().slice(0,10) === day; } catch { return false; }
};
export function validateSchedule(body, creating = false) {
  if (body.date_start != null && !date(body.date_start) || body.date_stop != null && !date(body.date_stop)) return 'invalid_schedule_date';
  if (creating && (!date(body.date_start) || typeof body.time_sending_timezone !== 'string')) return 'schedule_start_and_timezone_required';
  if (creating && body.date_start.length < 16) return 'schedule_initial_start_time_required';
  if (body.time_sending_timezone != null) {
    try { new Intl.DateTimeFormat('fr', { timeZone: body.time_sending_timezone }).format(); } catch { return 'invalid_schedule_timezone'; }
  }
  for (const key of Object.keys(body).filter(key => /^time_(?:start|stop)_sending(?:_|$)/.test(key))) {
    if (body[key] != null && !time(body[key])) return 'invalid_schedule_time';
  }
  for (const day of weekdays) if (body['allowed_' + day] != null && typeof body['allowed_' + day] !== 'boolean') return 'invalid_schedule_day';
  if (creating && (!Array.isArray(body.contactlist_ids) || !body.contactlist_ids.length || !body.contactlist_ids.every(id) || !weekdays.some(day => body['allowed_' + day] === true))) return 'invalid_schedule_audience_or_days';
  for (const key of ['daily_send_limit','limit_total_sending','copy_prospect_if_scoring_above']) if (body[key] != null && (!Number.isSafeInteger(body[key]) || body[key] < 0)) return 'invalid_schedule_limit';
  if (body.time_start_sending && body.time_stop_sending && body.time_start_sending >= body.time_stop_sending) return 'invalid_schedule_window';
  for (const day of weekdays) {
    const start = body['time_start_sending_' + day] ?? body.time_start_sending;
    const stop = body['time_stop_sending_' + day] ?? body.time_stop_sending;
    if (start && stop && start >= stop) return 'invalid_schedule_window';
  }
  if (body.date_stop && body.date_start && body.date_stop.replace('T',' ') < body.date_start.replace('T',' ')) return 'invalid_schedule_end';
  return null;
}
export function workflowDefaults(body) {
  if (!Array.isArray(body.steps) || !body.steps.length || body.auto_remove_responders != null && typeof body.auto_remove_responders !== 'boolean') return { error: 'invalid_workflow' };
  if (body.steps.some(step => !step || typeof step !== 'object' || step.disable_auto_remove_responders != null && typeof step.disable_auto_remove_responders !== 'boolean')) return { error: 'invalid_workflow_step' };
  const payload = { ...body, auto_remove_responders: body.auto_remove_responders ?? true,
    steps: body.steps.map(step => step.step_type === 'action' ? { ...step, disable_auto_remove_responders: step.disable_auto_remove_responders ?? false } : step) };
  // A reply branch conflicts with global exclusion: do not silently disable it.
  if (payload.auto_remove_responders && payload.steps.some(step => step.step_type === 'event' && /reply|replied|answer/i.test(step.event_type ?? ''))) return { error: 'reply_branch_conflicts_with_global_exclusion', note: 'Confirmer le traitement des répondeurs : une branche de réponse nécessite de désactiver la règle globale.' };
  return { payload };
}
// An explicit route and envelope per resource: no model-selected URLs.
export const SHARE_RESOURCES = {
  contact_list: ['/contact-lists','contact_list_profile'],
  workflow: ['/workflows','workflow'],
  email_model: ['/models/email','model_profile'],
  linkedin_message_model: ['/models/linkedin/message','model_profile'],
  linkedin_invitation_model: ['/models/linkedin/invitation','model_profile'],
  sms_model: ['/models/sms','model_profile'],
  voice_model: ['/models/smv','model_profile','POST'],
  email_signature: ['/email-signatures','email_signature_profile'],
  tag: ['/tags','tag_profile'], data_field: ['/data-fields','data_field_profile'],
  short_link: ['/urls-shortener','shortened_url_profile'], blacklist: ['/blacklists','blacklist_profile'],
  file: ['/files','file_profile','POST'], pool: ['/pools','pool_profile'],
  ai_agent: ['/ai-agents','agent'], linkedin_account: ['/integrations/linkedin','linkedin_account_profile'],
  email_account: ['/integrations/email','email_account_profile'], report: ['/reporting/report','report_profile'],
  mailgun_domain: ['/resellers/:reseller_id/mailgun/domains','domain','POST'],
};
export function resourceOf(data, key) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data[key] && typeof data[key] === 'object' && !Array.isArray(data[key])) return data[key];
  // Endpoint-specific profiles have varied names across versions of the API.
  const profiles = Object.entries(data).filter(([name,value]) => /_profile$/.test(name) && value && typeof value === 'object' && !Array.isArray(value));
  if (profiles.length === 1) return profiles[0][1];
  return data.id || data.steps ? data : null;
}
const targetIds = grant => grant.sharing_targets?.length ? grant.sharing_targets.map(target => target.id) : grant.ids_list;
export function mergeGrant(existing, userId, write = false, stats = false) {
  if (!Array.isArray(existing)) throw Error('sharing_unavailable');
  const grants = existing.filter(grant => !grant.implicit).map(grant => {
    const ids = targetIds(grant);
    if (!Array.isArray(ids) || !ids.every(id) || !ids.length && grant.sharing_type_to !== 'ResellerCustomers') throw Error('invalid_existing_sharing');
    return { name: grant.name || 'multiple', sharing_type_to: grant.sharing_type_to,
      read_permission: true, write_permission: stats ? false : grant.write_permission === true,
      delete_permission: stats ? false : grant.delete_permission === true, ids_list: ids.map(Number) };
  });
  // Additive only. Never downgrade or revoke another recipient's grant.
  if (!grants.some(grant => grant.sharing_type_to === 'User' && grant.ids_list.includes(userId) && (!write || grant.write_permission))) {
    grants.push({ name:'multiple', sharing_type_to:'User', read_permission:true, write_permission:stats ? false : write, delete_permission:false, ids_list:[userId] });
  }
  return grants;
}
export async function contactProperties(values, auth) {
  if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length || Object.keys(values).length > 100 || hasSecret(values)) return { error:'invalid_contact_values' };
  const r = await request('/data-fields', { auth });
  if (!r.ok) return failure(r);
  const fields = r.data?.data_fields_list;
  if (!Array.isArray(fields)) return { error:'data_fields_unavailable' };
  const properties = [];
  for (const [key,value] of Object.entries(values)) {
    const matches = fields.filter(field => String(field.id) === key || field.identifier === key);
    if (matches.length !== 1 || typeof value !== 'string' || value.length > 10000) return { error:'invalid_contact_field', field:key };
    if (properties.some(property => property.data_field_id === Number(matches[0].id))) return { error:'duplicate_contact_field', field:key };
    properties.push({ data_field_id:Number(matches[0].id), value });
  }
  return { properties };
}
const str = description => ({ type:'string', ...(description ? { description } : {}) });
const num = description => ({ type:'integer', minimum:1, ...(description ? { description } : {}) });
const definitions = [
  ['list_saved_filters','Lire les filtres sauvegardés du compte actif, notamment contact_lists_contacts. Réutiliser le filtre complet, pas un nom inventé.', { page:{ type:'string', enum:FILTER_PAGES }, name:str('Nom exact facultatif') }, []],
  ['add_contact_to_list','Ajouter manuellement un contact dans une liste existante. values associe identifiers réels (email, first_name…) ou ID de champs aux valeurs texte. Résolution et vérification côté serveur.', { list_id:num(), values:{ type:'object', additionalProperties:{ type:'string' } } }, ['list_id','values']],
  ['set_workflow_responder_exclusion','Configurer Exclure les répondeurs : sans step_id règle globale de séquence ; avec step_id exception de cette action uniquement (champ inversé). Préserve toutes les autres étapes et options.', { workflow_id:num(), step_id:str('ID step_id.id renvoyé par get_scenario'), enabled:{ type:'boolean' } }, ['workflow_id','enabled']],
  ['list_prm_reminders','Lire les rappels/appels d’un contact PRM, sans marquer les réponses lues. Dates conservées avec leur fuseau ; ne pas déduire un fuseau absent.', { contact_id:num() }, ['contact_id']],
  ['find_sharing_users','Chercher les destinataires de partage autorisés par Magileads. Nom/email/ID, 2 caractères minimum. Ne jamais inventer d’ID.', { query:str() }, []],
  ['share_resource','Partager une ressource avec un utilisateur, en lecture par défaut et sans retirer les partages existants. Une campagne distingue la séquence (workflow), les statistiques (campaign_statistics) et les prospects (campaign_prospects). Ne partager que les éléments explicitement demandés.', { kind:{ type:'string', enum:[...Object.keys(SHARE_RESOURCES),'campaign_statistics','campaign_prospects','saved_filter','prm_contact','prm'] }, resource_id:str('ID réel ; uniqid pour agent IA'), user_id:num(), write_permission:{ type:'boolean' }, workflow_id:num('Requis pour statistiques de campagne'), reseller_id:num('Requis pour domaine Mailgun ; droits revendeur contrôlés par l’API'), filter_page:{ type:'string',enum:FILTER_PAGES }, filter_name:str('Nom exact d’un filtre sauvegardé'), filter:{ type:'object' }, entire_prm:{ type:'boolean',description:'true seulement pour partager explicitement tout le PRM'} }, ['kind','user_id']],
];
export const BUSINESS_TOOLS = definitions.map(([name,description,properties,required]) => ({ type:'function', function:{ name,description,parameters:{ type:'object',properties,required,additionalProperties:false } } }));
export const BUSINESS_TOOL_NAMES = new Set(definitions.map(([name]) => name));

export async function executeBusiness(name, args, auth, context = {}) {
  if (!BUSINESS_TOOL_NAMES.has(name)) return null;
  if (!args || typeof args !== 'object' || hasSecret(args)) return { error:'invalid_arguments' };
  if (name === 'list_saved_filters') {
    if (args.page && !FILTER_PAGES.includes(args.page)) return { error:'invalid_filter_page' };
    const r = await request('/users/me', { auth });
    if (!r.ok) return failure(r);
    const saved = r.data?.user_profile?.saved_filters;
    return { filters:sanitize(Object.fromEntries(FILTER_PAGES.filter(page => !args.page || args.page === page).map(page => [page,(saved?.[page] ?? []).filter(row => !args.name || row.name === args.name)]))) };
  }
  if (name === 'find_sharing_users') {
    if (args.query != null && (typeof args.query !== 'string' || args.query.trim().length < 2)) return { error:'sharing_search_too_short' };
    const r = await request(args.query ? '/users/list/search?options=' + encodeURIComponent(JSON.stringify({per_page:50})) : '/users/list?options=' + encodeURIComponent(JSON.stringify({per_page:100})), { auth, ...(args.query ? { method:'POST',body:{query:args.query.trim()} } : {}) });
    return r.ok ? { users:(r.data?.results ?? []).map(user => ({ id:user.id,first_name:user.first_name,last_name:user.last_name,email:user.email })), total:r.data?.number_of_results, note:'Liste autorisée par l’API, pas nécessairement exhaustive.' } : failure(r);
  }
  if (name === 'add_contact_to_list') {
    if (!id(args.list_id)) return { error:'invalid_list_id' };
    const list = await request('/contact-lists/' + id(args.list_id), { auth });
    if (!list.ok) return failure(list);
    const properties = await contactProperties(args.values, auth);
    if (properties.error) return properties;
    const r = await writeOnce('/contact-lists/' + id(args.list_id) + '/contact', { auth, method:'POST',body:properties }, context);
    return r.ok ? { status:'accepted',list_id:id(args.list_id),data:sanitize(r.data) } : failure(r);
  }
  if (name === 'list_prm_reminders') {
    if (!id(args.contact_id)) return { error:'invalid_contact_id' };
    const r = await request('/prm/contact/' + id(args.contact_id), { auth });
    if (!r.ok) return failure(r);
    const profile = resourceOf(r.data,'contact_profile');
    if (!profile || !Array.isArray(profile.calls)) return { error:'prm_reminders_unavailable' };
    const asOf = new Date().toISOString();
    const upcoming = profile.calls.filter(call => typeof call.call_date === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(call.call_date) && Date.parse(call.call_date) >= Date.parse(asOf));
    return { contact_id:id(args.contact_id), as_of:asOf, reminders:sanitize(profile.calls),
      upcoming_reminders:sanitize(upcoming.sort((a,b) => Date.parse(a.call_date) - Date.parse(b.call_date))),
      note:'Les rappels à venir sont comparés à as_of uniquement si la date API comporte un fuseau. Les autres dates restent dans reminders, sans supposer leur fuseau.' };
  }
  if (name === 'set_workflow_responder_exclusion') {
    if (!id(args.workflow_id) || typeof args.enabled !== 'boolean' || args.step_id != null && !/^[a-zA-Z0-9_-]+$/.test(args.step_id)) return { error:'invalid_workflow_arguments' };
    const path = '/workflows/' + id(args.workflow_id), current = await request(path, { auth });
    if (!current.ok) return failure(current);
    const workflow = resourceOf(current.data,'workflow');
    if (!workflow || !Array.isArray(workflow.steps)) return { error:'workflow_steps_unavailable' };
    let body;
    if (args.step_id == null) {
      if (args.enabled && workflow.steps.some(step => step.step_type === 'event' && /reply|replied|answer/i.test(step.event_type ?? ''))) return { error:'reply_branch_conflicts_with_global_exclusion' };
      body = { auto_remove_responders:args.enabled };
    } else {
      const matches = workflow.steps.filter(step => String(step.step_id?.id ?? step.step_id) === String(args.step_id));
      if (matches.length !== 1 || matches[0].step_type !== 'action') return { error:'workflow_action_not_found' };
      body = { steps:workflow.steps.map(step => step === matches[0] ? { ...step,disable_auto_remove_responders:!args.enabled } : step) };
    }
    const r = await writeOnce(path, { auth, method:'PUT',body }, context);
    return r.ok ? { status:'accepted',workflow_id:id(args.workflow_id),scope:args.step_id == null ? 'sequence' : 'step',step_id:args.step_id,enabled:args.enabled, global_exclusion:args.step_id == null ? args.enabled : workflow.auto_remove_responders, note:args.step_id != null && !workflow.auto_remove_responders ? 'La règle globale est désactivée ; cette étape ne la réactive pas.' : undefined } : failure(r);
  }
  if (name === 'share_resource') return shareResource(args, auth, context);
}
async function writeOnce(path, options, context) {
  const key = JSON.stringify([path, options.method, options.body instanceof FormData ? [...options.body] : options.body]);
  context.businessWrites ??= new Set();
  if (context.businessWrites.has(key)) return { ok:false, errorKey:'mutation_already_attempted' };
  // Mark before sending, including uncertain network failures: no blind replay.
  context.businessWrites.add(key);
  return request(path, options);
}
async function shareResource(args, auth, context) {
  const userId = id(args.user_id);
  if (!userId || args.write_permission != null && typeof args.write_permission !== 'boolean') return { error:'invalid_sharing_arguments' };
  // Resolve the target from the API, not from guessed IDs or main-account switching.
  const recipients = await executeBusiness('find_sharing_users', String(userId).length >= 2 ? { query:String(userId) } : {}, auth);
  if (!recipients.users?.some(user => Number(user.id) === userId)) return { error:'sharing_user_not_verified', cause:recipients.error };
  const grant = { name:'multiple',sharing_type_to:'User',read_permission:true,write_permission:args.write_permission === true,delete_permission:false,ids_list:[userId] };
  if (['campaign_prospects','prm_contact','prm'].includes(args.kind)) {
    if (args.kind !== 'prm' && !id(args.resource_id)) return { error:'invalid_resource_id' };
    if (args.kind === 'prm' && !args.entire_prm && !args.filter?.values?.length) return { error:'explicit_prm_scope_required' };
    const filter = args.kind === 'campaign_prospects' ? {mode:'and',values:[{field_name:'programmation_id',type:'equals',value:String(id(args.resource_id))}]}
      : args.kind === 'prm_contact' ? {mode:'and',values:[{field_name:'id',type:'equals',value:String(id(args.resource_id))}]} : args.filter ?? {mode:'and',values:[]};
    if (!validPrmFilter(filter)) return {error:'invalid_prm_filter'};
    if (args.kind !== 'prm') {
      const source = await request(args.kind === 'prm_contact' ? '/prm/contact/' + id(args.resource_id) : '/statistics/programmations/' + id(args.resource_id), {auth});
      if (!source.ok) return failure(source);
    }
    const r = await writeOnce('/prm/sharings',{auth,method:'POST',body:{sharing:{...grant,filter,contact_ids:[]}}}, context);
    return r.ok ? {status:'accepted',kind:args.kind,user_id:userId,data:sanitize(r.data)} : failure(r);
  }
  if (args.kind === 'saved_filter') {
    if (!FILTER_PAGES.includes(args.filter_page) || typeof args.filter_name !== 'string') return {error:'invalid_saved_filter'};
    const r = await request('/users/me',{auth});
    if (!r.ok) return failure(r);
    const profile = r.data?.user_profile, saved = profile?.saved_filters;
    if (!saved || !Array.isArray(saved[args.filter_page])) return {error:'saved_filter_not_found'};
    const matches = saved[args.filter_page].filter(row=>row.name===args.filter_name);
    if (matches.length !== 1 || matches[0].created_by?.id != null && matches[0].created_by.id !== profile.id) return {error:'saved_filter_not_owned_or_ambiguous'};
    const next = Object.fromEntries(Object.entries(saved).map(([page,rows])=>[page,Array.isArray(rows) ? rows.filter(row=>row.created_by?.id == null || row.created_by.id === profile.id).map(row=>row === matches[0] ? {...row,sharing:mergeGrant(row.sharing ?? [],userId,args.write_permission === true)} : row) : rows]));
    const write = await writeOnce('/users/me',{auth,method:'PUT',body:{saved_filters:next}}, context);
    return write.ok ? {status:'accepted',kind:args.kind,user_id:userId} : failure(write);
  }
  const campaign = args.kind === 'campaign_statistics';
  const config = SHARE_RESOURCES[args.kind];
  if (!campaign && !config) return {error:'unsupported_sharing_resource'};
  if (args.kind === 'ai_agent' ? !/^[a-zA-Z0-9_-]+$/.test(args.resource_id ?? '') : !id(args.resource_id)) return {error:'invalid_resource_id'};
  if (campaign && !id(args.workflow_id)) return {error:'workflow_id_required'};
  if (args.kind === 'mailgun_domain' && !id(args.reseller_id)) return {error:'reseller_id_required'};
  const path = campaign ? '/workflows/' + id(args.workflow_id) + '/programmation/' + id(args.resource_id) : config[0].replace(':reseller_id',String(id(args.reseller_id))) + '/' + encodeURIComponent(args.resource_id);
  const r = await request(path,{auth});
  if (!r.ok) return failure(r);
  const resource = resourceOf(r.data,campaign ? 'workflow_programmation' : config[1]);
  if (!resource || resource.from_sharing || resource.permission?.write_permission === false || resource.write_permission === false) return {error:'resource_not_owned_or_writable'};
  const key = campaign ? 'stats_sharings' : 'sharing';
  if (!Array.isArray(resource[key])) return {error:'sharing_unavailable'};
  let merged;
  try { merged = mergeGrant(resource[key],userId,args.write_permission === true,campaign); } catch (error) { return {error:error.message}; }
  let writePath = path, body = {[key]:merged}, method = campaign ? 'PUT' : config[2] ?? 'PUT';
  if (args.kind === 'email_account') {
    const type = {SMTP:'smtp',Gmail:'gmail',Outlook:'outlook',MassMailing:'mass-mailing'}[resource.account_type];
    if (!type) return {error:'unknown_email_account_type'};
    writePath = '/integrations/email/' + type + '/' + id(args.resource_id);
  }
  if (['file','voice_model'].includes(args.kind)) {
    body = new FormData(); body.append('sharing',JSON.stringify(merged));
  }
  const written = await writeOnce(writePath,{auth,method,body}, context);
  return written.ok ? {status:'accepted',kind:args.kind,resource_id:args.resource_id,user_id:userId,permissions:{read:true,write:campaign ? false : grant.write_permission,delete:false}} : failure(written);
}
