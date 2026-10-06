import {
  API_BASE, getMe, listDataFields, listPrmPipelines, listPrmStatuses,
  listPrmCustomStatuses, listPrmContacts, request,
} from './magileads.js';

// PRM filters use named fields, unlike contact-list filters (numeric data-field IDs).
export const PRM_FIELDS = ['any_datafield', 'status', 'custom_status', 'is_positive',
  'new_reply', 'new_first_reply', 'in_active_programmation', 'score', 'person_in_charge',
  'tag_id', 'created_on', 'status_changed_date', 'last_reply_or_status_changed_date',
  'last_call', 'programmation_id', 'workflow_id', 'contact_list_id', 'id'];
const OPERATORS = ['equals', 'not_equals', 'contains', 'not_contains', 'does_exist',
  'does_not_exist', 'more_than', 'more_or_equal_than', 'less_than', 'less_or_equal_than'];
const FLAGS = new Set(['new_reply', 'new_first_reply', 'in_active_programmation']);
const STATUS_NAMES = {
  opener: ['Ouvreur', 'Ouvreurs', 'Openers', 'Opened'], clicker: ['Cliqueur', 'Cliqueurs', 'Clickers', 'Clicked'],
  answerer: ['Répondeur', 'Répondeurs', 'Responders', 'Repliers', 'Replied'], to_call: ['À rappeler', 'To call', 'To call back'],
  out_of_office: ['Absent', 'Absents', 'Out of office'],
};
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const normalized = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/[«»"“”]/g, '').replace(/\s+/g, ' ').trim();
const nameOf = row => row.name || [row.first_name, row.last_name].filter(Boolean).join(' ') || `#${row.id}`;
const errorOf = (response, fallback) => ({ error: response.errorKey || fallback, status_code: response.status });

const FILTER_SCHEMA = { type: 'object', additionalProperties: false, required: ['mode', 'values'], properties: {
  mode: { type: 'string', enum: ['and', 'or'] }, values: { type: 'array', items: {
    type: 'object', properties: {
      field_name: { type: 'string', enum: PRM_FIELDS }, type: { type: 'string', enum: OPERATORS },
      value: { type: 'string' }, mode: { type: 'string', enum: ['and', 'or'] },
      values: { type: 'array', items: { type: 'object' } },
    },
  } },
} };
const SELECTION = {
  user_id: { type: 'number', description: 'Propriétaire réel du PRM, fourni par la page ou list_prm_pipelines. Défaut : PRM ouvert, sinon compte connecté.' },
  column: { type: 'string', description: 'Nom réel de la colonne, ex. « My column » ou « Répondeur ». Le serveur résout et vérifie son statut. Omettre pour tout le PRM.' },
  custom_status: { type: 'number', description: 'ID réel d’une colonne personnalisée, si déjà connu. Ne pas inventer.' },
  status: { type: 'string', description: 'Code réel d’un statut système, si déjà connu (opener, clicker, answerer, to_call, out_of_office).' },
  filter: FILTER_SCHEMA,
  entire_prm: { type: 'boolean', description: 'true uniquement si l’utilisateur veut ignorer les filtres de la page. Le filtre explicitement demandé reste appliqué.' },
};
export const PRM_TOOLS = [
  ['list_prm_pipelines', 'Lister les PRM accessibles et leur propriétaire, sans lire leurs prospects ni marquer leurs réponses comme vues.', {}, []],
  ['list_prm_statuses', 'Lire les vraies colonnes du PRM sélectionné. Sur un PRM partagé, utiliser uniquement les statuts de son propriétaire exposés par Magileads.', { user_id: SELECTION.user_id }, []],
  ['count_prm_contacts', 'Compter exactement les prospects du PRM ou d’une colonne, avec les filtres de la page. Renvoie le total filtré fourni par Magileads ; aucun échantillon, aucune carte. À utiliser pour « combien de gens dans My column ? ».', SELECTION, []],
  ['copy_prm_to_blacklist', 'Copier les valeurs de champs de prospects PRM dans une blacklist existante, sans supprimer les prospects. Préserve le propriétaire, la colonne et les filtres de la page. Premier appel = aperçu ; rappeler avec confirm_count exactement égal au compte pour lancer une seule copie.', {
    ...SELECTION, blacklist_id: { type: 'integer', minimum: 1 },
    contact_ids: { type: 'array', maxItems: 500, items: { type: 'integer', minimum: 1 } },
    datafield_ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'integer', minimum: 1 }, description: 'Champs réels à copier, souvent email ou linkedin_url. Ne pas inventer leur ID.' },
    confirm_count: { type: 'integer', minimum: 0 },
  }, ['blacklist_id', 'datafield_ids']],
  ['query_prm_contacts', 'Lire des prospects PRM seulement si des personnes sont demandées. Filtrer réellement par colonne et/ou critères. Échantillon de 25 maximum, total exact séparé, pagination par next_page (jamais page=2). Aucune carte.', {
    ...SELECTION, search: { type: 'string', description: 'Recherche plein texte, 3 caractères minimum, appliquée via any_datafield contains.' },
    limit: { type: 'number', description: '1 à 25, défaut 10.' },
    next_page: { type: 'string', description: 'Curseur next_page renvoyé par la lecture précédente. Garder les mêmes critères.' },
  }, []],
].map(([name, description, properties, required]) => ({ type: 'function', function: {
  name, description, parameters: { type: 'object', additionalProperties: false, properties, required },
} }));
export const PRM_TOOL_NAMES = new Set(PRM_TOOLS.map(tool => tool.function.name));

export function validPrmFilter(filter, depth = 0) {
  if (filter == null) return true;
  if (depth > 8 || !filter || typeof filter !== 'object' || Array.isArray(filter) ||
    !['and', 'or'].includes(filter.mode) || !Array.isArray(filter.values) || filter.values.length > 50) return false;
  return filter.values.every(condition => {
    if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return false;
    if ('mode' in condition) return validPrmFilter(condition, depth + 1);
    if (!PRM_FIELDS.includes(condition.field_name) || !OPERATORS.includes(condition.type) ||
      typeof condition.value !== 'string') return false;
    if (FLAGS.has(condition.field_name) && (condition.type !== 'equals' || !['0', '1'].includes(condition.value))) return false;
    return condition.field_name !== 'any_datafield' ||
      (['contains', 'not_contains'].includes(condition.type) && condition.value.trim().length >= 3);
  });
}

/** Read-only page scope. Credentials and Magileads permissions remain authoritative. */
export function readPrmPageContext(content) {
  if (typeof content !== 'string' || !/^\[Screen context/.test(content)) return null;
  const line = content.match(/^PRM context: (.+)$/m)?.[1];
  if (!line) return null;
  try {
    const page = JSON.parse(line);
    if (!positiveId(page.user_id) || !Array.isArray(page.columns) || !validPrmFilter(page.filter) ||
      !page.columns.every(column => column && typeof column.name === 'string' &&
        typeof column.key === 'string' && typeof column.system === 'boolean')) return null;
    return { ...page, user_id: Number(page.user_id), exclude_custom: page.exclude_custom === true };
  } catch { return null; }
}

async function scopeFor(args, auth, context) {
  const me = context.profile ? { ok: true, data: { user_profile: context.profile } } : await getMe(auth);
  if (!me.ok) return errorOf(me, 'prm_profile_unavailable');
  const profile = me.data?.user_profile ?? me.data;
  const ownId = positiveId(profile?.id);
  if (!ownId) return { error: 'prm_owner_unavailable' };
  const response = await listPrmPipelines(auth);
  if (!response.ok || !Array.isArray(response.data?.prm)) return errorOf(response, 'prm_pipelines_unavailable');
  const owners = response.data.prm.filter(row => positiveId(row?.id)).map(row => ({
    id: Number(row.id), name: nameOf(row), own: Number(row.id) === ownId,
  }));
  const page = context.prmPage;
  const id = args.user_id == null ? page?.user_id ?? ownId : positiveId(args.user_id);
  if (!id) return { error: 'invalid_prm_owner' };
  const owner = owners.find(row => row.id === id) ?? (id === ownId ? { id, name: nameOf(profile), own: true } : null);
  if (!owner) return { error: 'prm_not_accessible', note: 'Choisis uniquement un PRM de list_prm_pipelines ou de la page ouverte.' };
  return { profile, owners, owner, ownerRow: response.data.prm.find(row => Number(row.id) === id),
    page: page?.user_id === id ? page : null };
}

async function columnsFor(scope, auth) {
  // /prm/list can expose each shared owner's statuses. Never substitute the
  // viewer's custom statuses: /prm/status/custom is always viewer-scoped.
  const sharedCustom = !scope.owner.own && Array.isArray(scope.ownerRow?.custom_status);
  const [system, custom] = await Promise.all([
    !scope.owner.own && Array.isArray(scope.ownerRow?.status)
      ? Promise.resolve({ ok: true, data: { status: scope.ownerRow.status } }) : listPrmStatuses(auth),
    scope.owner.own ? listPrmCustomStatuses(auth)
      : Promise.resolve({ ok: true, data: { status: sharedCustom ? scope.ownerRow.custom_status : [] } }),
  ]);
  if (!system.ok || !custom.ok || !Array.isArray(system.data?.status) || !Array.isArray(custom.data?.status)) {
    return { error: 'prm_columns_unavailable', note: 'Impossible de vérifier les colonnes ; ne devine pas leur identifiant.' };
  }
  const columns = [
    ...system.data.status.map(row => ({ key: row.status, system: true,
      name: STATUS_NAMES[row.status]?.[0] ?? row.status, aliases: STATUS_NAMES[row.status] ?? [], visible: row.visible !== false })),
    ...custom.data.status.map(row => ({ key: String(row.id), system: false,
      name: row.name, aliases: [], visible: row.visible !== false })),
  ].filter(column => typeof column.key === 'string' && typeof column.name === 'string');
  for (const column of columns) {
    const displayed = scope.page?.columns.find(row => row.key === column.key && row.system === column.system);
    if (displayed) column.aliases.push(displayed.name);
  }
  return { columns, customColumnsAvailable: scope.owner.own || sharedCustom,
    excludeCustom: scope.page ? scope.page.exclude_custom : columns.some(column => !column.system && column.visible) };
}

async function selectionFor(args, scope, auth) {
  if (!validPrmFilter(args.filter)) return { error: 'invalid_prm_filter', allowed_fields: PRM_FIELDS,
    note: 'Les filtres PRM utilisent les noms de champs, pas les ID des champs de listes de contacts.' };
  const conditions = [];
  let column = null;
  if (args.column != null || args.custom_status != null || args.status != null) {
    const available = await columnsFor(scope, auth);
    if (available.error) return available;
    const customId = args.custom_status == null ? null : positiveId(args.custom_status);
    if (args.custom_status != null && !customId || args.custom_status != null && args.status != null) return { error: 'invalid_prm_column' };
    const matches = available.columns.filter(item =>
      (args.column == null || [item.name, item.key, ...item.aliases].some(name => normalized(name) === normalized(args.column))) &&
      (args.custom_status == null || !item.system && Number(item.key) === customId) &&
      (args.status == null || item.system && item.key === args.status));
    if (matches.length !== 1) return { error: matches.length ? 'prm_column_ambiguous' : 'prm_column_not_found',
      columns: (matches.length ? matches : available.columns).map(({ key, system, name }) => ({ key, system, name })),
      note: scope.owner.own ? 'Ne remplace pas une colonne inconnue par une lecture globale ; demande de préciser son nom.'
        : 'Les colonnes personnalisées du PRM partagé ne sont pas exposées par Magileads. Ne les remplace pas par celles du compte connecté.' };
    column = matches[0];
    conditions.push({ field_name: column.system ? 'status' : 'custom_status', type: 'equals', value: column.key });
    // Custom filing keeps the old system status; match the board, avoiding double counts.
    if (column.system && available.excludeCustom) conditions.push({ field_name: 'custom_status', type: 'does_not_exist', value: '' });
  }
  if (!args.entire_prm && scope.page?.filter?.values.length) conditions.push(scope.page.filter);
  if (args.filter?.values.length) conditions.push(args.filter);
  if (args.search != null && typeof args.search !== 'string') return { error: 'invalid_prm_search' };
  const search = args.search?.trim();
  if (search) {
    if (search.length < 3) return { error: 'prm_search_too_short', note: 'La recherche nécessite au moins trois caractères.' };
    conditions.push({ field_name: 'any_datafield', type: 'contains', value: search });
  }
  return { column: column ? { key: column.key, system: column.system, name: column.name } : null,
    filter: conditions.length ? { mode: 'and', values: conditions } : null };
}

function cursorPath(nextPage, ownerId, options) {
  try {
    const url = new URL(nextPage, `${API_BASE}/`), base = new URL(API_BASE);
    if (url.origin !== base.origin || url.username || url.password || url.hash ||
      !new RegExp(`^/prm/contacts/user/${ownerId}/[1-9]\\d*/page/[1-9]\\d*$`).test(url.pathname)) return null;
    return `${url.pathname}?options=${encodeURIComponent(JSON.stringify(options))}`;
  } catch { return null; }
}

async function contactsFor(env, auth, limit, scope) {
  const rows = Array.isArray(env.results) ? env.results.slice(0, limit) : [];
  if (!rows.length) return [];
  const fields = Array.isArray(scope.ownerRow?.datafields) && scope.ownerRow.datafields.length
    ? { ok: true, data: { data_fields_list: scope.ownerRow.datafields } } : await listDataFields(auth);
  if (!fields.ok) return null;
  const names = new Map((fields.data?.data_fields_list ?? []).map(field => [String(field.id),
    String(field.identifier ?? field.identifier_placeholder ?? field.name ?? '').replace(/^%|%$/g, '')]));
  const useful = new Set(['first_name', 'last_name', 'email', 'job_title', 'company', 'contact_location', 'phone', 'linkedin_url']);
  return rows.map(row => {
    const data = Object.fromEntries((row.properties ?? []).flatMap(property => {
      const name = names.get(String(property.data_field_id)) ?? String(property.identifier ?? '').replace(/^%|%$/g, '');
      return useful.has(name) && property.value != null ? [[name, String(property.value).slice(0, 200)]] : [];
    }));
    return { id: row.id, ...data, status: row.status ?? null, custom_status: row.custom_status ?? null,
      is_positive: row.is_positive ?? null, new_reply: row.new_reply ?? null,
      number_of_replies: row.number_of_replies ?? null, score: row.score ?? null,
      person_in_charge: row.person_in_charge ?? null };
  });
}

export async function executePrmTool(name, args, auth, context = {}) {
  const scope = await scopeFor(args, auth, context);
  if (scope.error) return scope;
  if (name === 'list_prm_pipelines') return { pipelines: scope.owners, selected_user_id: scope.owner.id };
  if (name === 'list_prm_statuses') {
    const available = await columnsFor(scope, auth);
    return available.error ? available : { user_id: scope.owner.id, owner_name: scope.owner.name,
      columns: available.columns, custom_columns_available: available.customColumnsAvailable };
  }
  const selection = await selectionFor(args, scope, auth);
  if (selection.error) return selection;
  if (name === 'copy_prm_to_blacklist') {
    const numericId = value => typeof value === 'number' && positiveId(value) !== null;
    if (!numericId(args.blacklist_id) || !Array.isArray(args.datafield_ids) || !args.datafield_ids.length || args.datafield_ids.length > 100 || !args.datafield_ids.every(numericId) ||
      args.contact_ids != null && (!Array.isArray(args.contact_ids) || args.contact_ids.length > 500 || !args.contact_ids.every(numericId))) return { error: 'invalid_blacklist_selection' };
    const ids = args.contact_ids ?? [];
    if (!ids.length && !selection.filter?.values.length && args.entire_prm !== true) return { error: 'explicit_blacklist_scope_required' };
    // Explicit IDs are ANDed with the live page/column filter, never broaden it.
    const filter = ids.length ? { mode: 'and', values: [
      ...(selection.filter?.values.length ? [selection.filter] : []),
      { mode: 'or', values: ids.map(id => ({ field_name: 'id', type: 'equals', value: String(id) })) },
    ] } : selection.filter ?? { mode: 'and', values: [] };
    const blacklist = await request(`/blacklists/${args.blacklist_id}`, { auth });
    if (!blacklist.ok) return errorOf(blacklist, 'blacklist_unavailable');
    const fields = Array.isArray(scope.ownerRow?.datafields) && scope.ownerRow.datafields.length
      ? { ok: true, data: { data_fields_list: scope.ownerRow.datafields } }
      : scope.owner.own ? await listDataFields(auth) : null;
    if (!fields?.ok || !Array.isArray(fields.data?.data_fields_list)) return { error: 'prm_fields_unavailable' };
    if (!args.datafield_ids.every(id => fields.data.data_fields_list.some(field => Number(field.id) === Number(id)))) return { error: 'invalid_blacklist_data_fields' };
    const preview = await listPrmContacts(auth, { per_page: 1, filter }, scope.owner.id);
    if (!preview.ok) return errorOf(preview, 'prm_preview_unavailable');
    const count = preview.data?.number_of_results;
    if (!Number.isSafeInteger(count) || count < 0) return { error: 'prm_count_unavailable' };
    if (!count) return { status: 'nothing_to_copy', count: 0 };
    if (args.confirm_count !== count) return { dry_run: true, count, user_id: scope.owner.id,
      blacklist_id: args.blacklist_id, filter, note: 'Rappeler avec confirm_count égal au compte ; aucune copie envoyée.' };
    const key = JSON.stringify([scope.owner.id, args.blacklist_id, filter, [...new Set(args.datafield_ids)].sort()]);
    context.blacklistCopies ??= new Set();
    if (context.blacklistCopies.has(key)) return { error: 'mutation_already_attempted' };
    context.blacklistCopies.add(key);
    const result = await request(`/prm/contacts/user/${scope.owner.id}/copy/blacklist/${args.blacklist_id}`, {
      auth, method: 'POST', body: { contacts_selection: { filter, contact_ids: [], excluded_contact_ids: [] }, datafield_ids: [...new Set(args.datafield_ids)] },
    });
    return result.ok ? { status: 'accepted', count, blacklist_id: args.blacklist_id, user_id: scope.owner.id,
      note: 'Copie lancée, pas une suppression. Ne pas relancer le traitement accepté.' } : errorOf(result, 'blacklist_copy_failed');
  }
  const countOnly = name === 'count_prm_contacts';
  const limit = countOnly ? 1 : Math.min(Math.max(Math.trunc(Number(args.limit)) || 10, 1), 25);
  const options = { per_page: limit, ...(selection.filter ? { filter: selection.filter } : {}) };
  // Ignore no paging hint silently: PRM uses cursors, not offset pages.
  if (args.page != null && Number(args.page) > 1) return { error: 'prm_cursor_required', note: 'Utilise le next_page de la réponse précédente.' };
  const path = args.next_page ? cursorPath(args.next_page, scope.owner.id, options) : null;
  if (args.next_page && (!path || countOnly)) return { error: 'invalid_prm_cursor' };
  const response = path ? await request(path, { auth }) : await listPrmContacts(auth, options, scope.owner.id);
  if (!response.ok) return errorOf(response, 'prm_contacts_unavailable');
  const total = response.data?.number_of_results;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) return { error: 'prm_count_unavailable',
    note: 'Le total filtré manque ; ne déduis jamais un compte du nombre de prospects retournés.' };
  const result = { user_id: scope.owner.id, owner_name: scope.owner.name, column: selection.column,
    filter: selection.filter, count: total };
  if (countOnly) return result;
  const contacts = await contactsFor(response.data, auth, limit, scope);
  if (!contacts) return { error: 'prm_fields_unavailable' };
  return { ...result, total, returned: contacts.length, contacts, next_page: response.data.next_page ?? null,
    note: 'Les prospects sont un échantillon. Le total filtré est exact ; pour un comptage, utilise count_prm_contacts.' };
}
