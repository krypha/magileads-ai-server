import { OPERATIONS } from './operations.js';
// Cards are derived from tool results, never from model-generated markup.
export function changesData(name, raw, argsRaw = '{}') {
  try {
    const result = JSON.parse(raw), args = JSON.parse(argsRaw);
    if (result.error) return false;
    if (name === 'run_operation') return result.status === 'accepted' && OPERATIONS.some(op => op.name === args.operation && op.method !== 'GET');
    return ['run_linkedin_targeting', 'run_google_maps_targeting'].includes(name) && Boolean(result.list_id);
  } catch { return false; }
}
export function cardsForTool(name, raw, argsRaw = '{}') {
  let result, args;
  try { result = JSON.parse(raw); args = JSON.parse(argsRaw); } catch { return []; }
  if (!result || result.error || result._truncated) return [];
  if (name === 'connect_email') return [{ kind: 'email' }];
  if (name === 'open_commercial_form') return [{ kind: 'form', form: result.form }];
  if (name === 'list_contact_lists') return [{ kind: 'lists', items: result.lists ?? [], total: result.matched ?? result.total ?? result.total_lists }];
  if (name === 'get_contact_list') return [{ kind: 'lists', items: [result] }];
  if (name === 'list_campaigns') return [{ kind: 'campaigns', items: result.campaigns ?? [], total: result.total }];
  if (name === 'list_dropcontact_connections') return [{ kind: 'connections', items: result.connections ?? [] }];
  if (name === 'query_prm_contacts') return [{ kind: 'leads', items: (result.contacts ?? []).map(contact => ({ id: contact.id, name: [contact.first_name, contact.last_name].filter(Boolean).join(' ') || `#${contact.id}`, status: contact.status ?? null, new_reply: contact.new_reply ?? null })), total: result.total }];
  if (['run_linkedin_targeting', 'run_google_maps_targeting'].includes(name) && result.list_id) return [{ kind: 'lists', items: [{ id: result.list_id, name: result.list_name }] }];
  if (name === 'run_operation' && result.status === 'accepted') {
    if (args.operation === 'duplicate_contact_list') return [{ kind: 'result', operation: args.operation, id: result.data?.contact_list_id ?? null }];
    if (args.operation === 'enrich_dropcontact') return [{ kind: 'result', operation: args.operation, id: result.resource_id ?? null }];
  }
  return [];
}
