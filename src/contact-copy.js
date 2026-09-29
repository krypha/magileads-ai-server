import { getContactListProfile, listDataFields, listContactListContacts, request } from './magileads.js';
import { hasSecret } from './assistant-policy.js';

const OPERATORS = ['equals', 'not_equals', 'contains', 'not_contains', 'start_with', 'end_with', 'does_exist', 'does_not_exist',
  'more_than', 'more_or_equal_than', 'less_than', 'less_or_equal_than'];
const NO_VALUE = new Set(['does_exist', 'does_not_exist']);
export const CONTACT_COPY_FILTER_SCHEMA = {
  type: 'object', required: ['mode', 'values'], additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['and', 'or'] },
    values: { type: 'array', minItems: 1, items: {
      type: 'object', description: 'Condition avec field_name, type et value, ou groupe imbriqué mode/values.',
      properties: {
        field_name: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'ID numérique de list_contact_fields en texte, jamais le nom ou identifier.' },
        type: { type: 'string', enum: OPERATORS }, value: { type: ['string', 'array'], items: { type: 'string' } },
        mode: { type: 'string', enum: ['and', 'or'] }, values: { type: 'array', minItems: 1, items: { type: 'object' } },
      },
    } },
  },
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => Object.keys(value).every(key => keys.includes(key));
const id = value => (typeof value === 'number' || typeof value === 'string') && /^[1-9][0-9]*$/.test(String(value)) &&
  Number.isSafeInteger(Number(value)) ? Number(value) : null;
function normalizeFilter(filter, fields) {
  if (!object(filter) || !only(filter, ['mode', 'values']) || !['and', 'or'].includes(filter.mode) || !Array.isArray(filter.values) || !filter.values.length) throw Error('invalid_contact_filter');
  return { mode: filter.mode, values: filter.values.map(condition => {
    if (!object(condition)) throw Error('invalid_contact_filter');
    if (condition.field_name === undefined) return normalizeFilter(condition, fields);
    const field = id(condition.field_name);
    if (!field || !only(condition, ['field_name', 'type', 'value']) || !OPERATORS.includes(condition.type)) throw Error('invalid_contact_filter');
    const validValue = typeof condition.value === 'string' ? Boolean(condition.value.trim())
      : Array.isArray(condition.value) && condition.value.length > 0 && condition.value.every(value => typeof value === 'string' && value.trim());
    if (!NO_VALUE.has(condition.type) && !validValue) throw Error('invalid_contact_filter');
    fields.add(field);
    return { field_name: String(field), type: condition.type, value: NO_VALUE.has(condition.type) ? '' : condition.value };
  }) };
}
function profile(response, expected) {
  const data = response.ok ? response.data?.contact_list_profile ?? response.data : null;
  return data && id(data.id) === expected ? data : null;
}

/** Copy the entire API-filtered segment, never the model's sample of contacts. */
export async function copyContactsToList(args, auth, { copyAttempts } = {}) {
  if (!object(args) || hasSecret(args) || !only(args, ['source_list_id', 'filter', 'destination_list_id', 'new_list_name'])) return { error: 'invalid_arguments' };
  const sourceId = id(args.source_list_id), destinationId = args.destination_list_id == null ? null : id(args.destination_list_id);
  const hasName = args.new_list_name != null;
  if (!sourceId || (args.destination_list_id != null && !destinationId) ||
    (hasName && (typeof args.new_list_name !== 'string' || !args.new_list_name.trim()))) return { error: 'invalid_copy_destination' };
  if (destinationId === sourceId) return { error: 'cannot_copy_into_source_list' };
  if (destinationId && hasName) return { error: 'choose_existing_destination_or_new_list' };
  let filter;
  const fields = new Set();
  try { filter = normalizeFilter(args.filter, fields); } catch { return { error: 'invalid_contact_filter', note: 'Un filtre non vide, avec les ID numériques des champs et des opérateurs valides, est obligatoire.' }; }

  const [sourceResponse, fieldsResponse, destinationResponse] = await Promise.all([
    getContactListProfile(auth, sourceId), listDataFields(auth),
    destinationId ? getContactListProfile(auth, destinationId) : null,
  ]);
  const source = profile(sourceResponse, sourceId), destination = destinationId ? profile(destinationResponse, destinationId) : null;
  if (!source) return { error: 'source_list_unavailable' };
  if (destinationId && !destination) return { error: 'destination_list_unavailable' };
  const knownFields = fieldsResponse.ok && Array.isArray(fieldsResponse.data?.data_fields_list)
    ? new Set(fieldsResponse.data.data_fields_list.map(field => id(field.id))) : null;
  if (!knownFields || [...fields].some(field => !knownFields.has(field))) return { error: 'unknown_contact_field', note: 'Relis list_contact_fields et utilise ses ID numériques.' };

  const preview = await listContactListContacts(auth, sourceId, { per_page: 1, filter });
  const rawCount = preview.data?.number_of_results ?? preview.data?.number_of_contacts;
  const count = rawCount === undefined || rawCount === null || typeof rawCount === 'boolean' || rawCount === '' ? NaN : Number(rawCount);
  if (!preview.ok || !Number.isSafeInteger(count) || count < 0) return { error: 'copy_preview_unavailable' };
  if (count === 0) return { status: 'no_matches', source_list_id: sourceId, matched_contacts: 0, note: 'Aucun contact ne correspond au filtre : aucune liste créée et aucune copie lancée.' };

  const name = hasName ? args.new_list_name.trim() : null;
  const key = JSON.stringify([sourceId, destinationId, name, filter]);
  if (copyAttempts?.has(key)) return { error: 'copy_already_requested', note: 'Cette copie a déjà été demandée dans cette réponse. Ne la relance pas ; utilise le résultat précédent ou vérifie les jobs.' };
  copyAttempts?.add(key);
  const body = { contacts_selection: { contact_ids: [], filter, excluded_contact_ids: [], reverse_selection: false },
    ...(destinationId ? { contact_list_id_destination: destinationId } : {}) };
  const copied = await request(`/contact-lists/${sourceId}/copy`, { auth, method: 'POST', body });
  if (!copied.ok) return { error: copied.errorKey || 'copy_failed', status_code: copied.status,
    note: 'Ne relance pas automatiquement : vérifie les jobs avant une nouvelle tentative si le résultat du réseau est incertain.' };

  const returnedId = id(copied.data?.contact_list_id);
  const listId = destinationId ?? (returnedId !== sourceId ? returnedId : null);
  const warnings = [];
  let listName = typeof destination?.name === 'string' ? destination.name : null;
  if (!listId) warnings.push('L’API a accepté la copie sans renvoyer un ID de destination exploitable. Vérifie les listes et leurs jobs, sans relancer la copie.');
  if (listId && !destinationId && name) {
    const renamed = await request(`/contact-lists/${listId}`, { auth, method: 'PUT', body: { name } });
    if (renamed.ok) listName = name;
    else warnings.push('La copie est lancée, mais le renommage de la nouvelle liste a échoué.');
  }
  if (listId && !listName) {
    const actual = profile(await getContactListProfile(auth, listId), listId);
    listName = typeof actual?.name === 'string' ? actual.name : null;
  }
  return { operation: 'copy_contacts_to_list', status: 'accepted', source_list_id: sourceId, source_list_name: source.name,
    list_id: listId, list_name: listName, matched_contacts: count, criteria_applied: { filter }, warnings,
    note: 'Copie lancée en arrière-plan pour tous les contacts correspondant au filtre, sans limite d’échantillon. Le comptage est l’aperçu au lancement, pas le nombre déjà copié ; les résultats définitifs sont dans les jobs de la destination. Ne relance pas.' };
}
