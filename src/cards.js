import { OPERATIONS } from './operations.js';
// Cards are derived from tool results, never from model-generated markup.
export function changesData(name, raw, argsRaw = '{}') {
  try {
    const result = JSON.parse(raw), args = JSON.parse(argsRaw);
    if (result.error) return false;
    if (['copy_contacts_to_list','copy_prm_to_blacklist','add_contact_to_list','share_resource','set_workflow_responder_exclusion'].includes(name)) return result.status === 'accepted';
    if (name === 'run_operation') return result.status === 'accepted' && OPERATIONS.some(op => op.name === args.operation && op.method !== 'GET');
    return ['run_linkedin_targeting', 'run_google_maps_targeting', 'run_sales_navigator_targeting', 'run_database_targeting'].includes(name) && Boolean(result.list_id);
  } catch { return false; }
}
export function cardsForTool(name, raw, argsRaw = '{}') {
  let result, args;
  try { result = JSON.parse(raw); args = JSON.parse(argsRaw); } catch { return []; }
  if (!result || result.error || result._truncated) return [];
  if ((name === 'copy_contacts_to_list' || name === 'run_operation' && args.operation === 'copy_contacts_to_list') && result.status === 'accepted' && result.list_id) {
    return [{ kind: 'lists', items: [{ id: result.list_id, name: result.list_name ?? `#${result.list_id}` }], purpose: 'created' }];
  }
  if (name === 'create_document' && result.status === 'document_ready') return [{ kind: 'document', document: result.document }];
  if (name === 'connect_email') return [{ kind: 'email', ...(result.account_id != null ? { account_id: result.account_id } : {}) }];
  if (name === 'open_commercial_form') return [{ kind: 'form', form: result.form, ...(result.list_id != null ? { list_id: result.list_id } : {}) }];
  if (name === 'ask_contact_list' && result.lists?.length) return [{ kind: 'lists', items: result.lists, total: result.matched ?? result.total ?? result.total_lists, purpose: 'selection' }];
  if (name === 'ask_campaign') return [{ kind: 'campaigns', items: result.campaigns ?? [], total: result.total, purpose: 'selection' }];
  if (name === 'list_dropcontact_connections') return [{ kind: 'connections', items: result.connections ?? [] }];
  if (['run_linkedin_targeting', 'run_google_maps_targeting', 'run_sales_navigator_targeting', 'run_database_targeting'].includes(name) && result.list_id) return [{ kind: 'lists', items: [{ id: result.list_id, name: result.list_name }], purpose: 'created' }];
  if (name === 'run_operation' && result.status === 'accepted') {
    if (args.operation === 'duplicate_contact_list') return [{ kind: 'result', operation: args.operation, id: result.data?.contact_list_id ?? null }];
    if (args.operation === 'enrich_dropcontact') return [{ kind: 'result', operation: args.operation, id: result.resource_id ?? null }];
  }
  return [];
}
