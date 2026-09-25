import { readFileSync } from 'node:fs';
import {
  countDatabaseTargeting,
  extractDatabaseTargeting,
  generateSalesNavSearchUrl,
  getContactListProfile,
  linkedinExtract,
  listLinkedinAccounts,
  searchDatabaseLocations,
  searchLinkedinLocations,
} from './magileads.js';

// These IDs and labels are copied from the v4 French/English industry selector.
// The generator still verifies that each selected ID changes the returned URL.
const INDUSTRIES = JSON.parse(readFileSync(new URL('./linkedin-industries.json', import.meta.url), 'utf8'));
const SOURCES = new Set(['linkedin', 'sales_navigator', 'database', 'google_maps']);
const TEXT_FIELDS = new Set(['job_title', 'contact_location', 'company', 'company_size', 'activity', 'category', 'zip_code', 'naf_code', 'country']);
const PRESENCE_FIELDS = new Set(['phone', 'linkedin_url', 'website', 'summary']);
const OPERATORS = new Set(['contains', 'does_not_contain', 'starts_with', 'does_not_start_with', 'ends_with', 'does_not_end_with', 'exact_match']);
const COMPANY_SIZES = new Set(['0-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001-10000', '10001+']);
const HEAD_COUNTS = ['independant', '1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001-10000', '10001-above'];
const SENIORITY = {
  in_training: 'En formation', entry_level: 'Débutant', senior: 'Senior', strategic: 'Stratégique',
  entry_level_manager: 'Manager débutant', experienced_manager: 'Manager expérimenté',
  director: 'Directeur', vice_president: 'Vice-président', cxo: 'CXO', owner_partner: 'Propriétaire/Partenaire',
};

const words = (value, limit = 15) => Array.isArray(value)
  ? [...new Set(value.filter(item => typeof item === 'string').map(item => item.trim().slice(0, 120)).filter(Boolean))].slice(0, limit)
  : [];
export const positiveId = value => (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) &&
  Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const fold = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

export function hasPermission(profile, name) {
  const value = Array.isArray(profile?.permissions)
    ? profile.permissions.find(item => item.name === name)?.value
    : profile?.permissions?.[name];
  return value === true || value === 'true' || value === 1;
}

/** Exact, stable shape for targeting.criteria; readiness is computed, not trusted. */
export function normalizeTargeting(input = {}) {
  const source = SOURCES.has(input.source) ? input.source : null;
  const criteria = {
    source,
    job_titles: words(input.job_titles),
    seniority: words(input.seniority),
    sectors: words(input.sectors),
    company_size_min: Number.isSafeInteger(input.company_size_min) && input.company_size_min >= 0 ? input.company_size_min : null,
    company_size_max: Number.isSafeInteger(input.company_size_max) && input.company_size_max >= 0 ? input.company_size_max : null,
    locations: words(input.locations),
    companies: words(input.companies),
    activity: typeof input.activity === 'string' ? input.activity.trim().slice(0, 120) || null : null,
    cities: words(input.cities),
    exclusions: words(input.exclusions),
    max_results: Number.isSafeInteger(input.max_results) && input.max_results > 0 ? Math.min(input.max_results, 10000) : null,
    ready_to_launch: false,
    missing: [],
  };
  const missing = criteria.missing;
  if (!source) missing.push('Choisir une source de recherche.');
  if (criteria.company_size_min !== null && criteria.company_size_max !== null && criteria.company_size_min > criteria.company_size_max) missing.push('Corriger les bornes de taille d’entreprise.');
  const maxAllowed = source === 'google_maps' ? 200 : source === 'database' ? 10000 : 1000;
  if (criteria.max_results !== null && criteria.max_results > maxAllowed) missing.push(`Cette source accepte au plus ${maxAllowed} résultats.`);
  if (source === 'google_maps') {
    if (!criteria.activity) missing.push('Préciser une activité.');
    if (!criteria.cities.length) missing.push('Préciser au moins une ville.');
  } else if (source === 'linkedin' || source === 'sales_navigator') {
    const professionalCriterion = source === 'linkedin'
      ? criteria.job_titles.length || criteria.companies.length
      : criteria.job_titles.length || criteria.companies.length || criteria.sectors.length ||
        criteria.company_size_min !== null || criteria.company_size_max !== null || criteria.seniority.length;
    if (!professionalCriterion) missing.push(source === 'linkedin'
      ? 'Préciser un poste ou une entreprise pour LinkedIn classique.'
      : 'Préciser un poste, un secteur, une entreprise ou un autre critère professionnel.');
    if (!criteria.locations.length) missing.push('Préciser une zone géographique.');
  } else if (source === 'database') {
    if (!criteria.job_titles.length && !criteria.sectors.length && !criteria.companies.length && !criteria.activity &&
      !criteria.locations.length && !criteria.cities.length && criteria.company_size_min === null && criteria.company_size_max === null) {
      missing.push('Préciser au moins un filtre pour la base Magileads.');
    }
  }
  criteria.ready_to_launch = missing.length === 0;
  return criteria;
}

export async function resolveListTarget(args, auth) {
  const id = args.contact_list_id == null ? null : positiveId(args.contact_list_id);
  const name = typeof args.list_name === 'string' ? args.list_name.trim() : '';
  if (name.length > 80) return { error: 'Le nom de liste dépasse 80 caractères ; précise un nom plus court.' };
  if (args.contact_list_id != null && id === null) return { error: 'contact_list_id invalide' };
  if (id && name) return { error: 'Choisis list_name OU contact_list_id, pas les deux.' };
  if (!id && !name) return { error: 'list_name ou contact_list_id manquant' };
  if (!id) return { name, payload: { contact_list_name: name, contact_list_id: null } };
  const response = await getContactListProfile(auth, id);
  if (!response.ok) return { error: 'Liste existante introuvable ou inaccessible pour ce compte.' };
  const profile = response.data?.contact_list_profile ?? response.data;
  return { id, name: typeof profile?.name === 'string' && profile.name ? profile.name : `Liste #${id}`, payload: { contact_list_name: null, contact_list_id: id } };
}

export function validateDatabaseFilters(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 25) return { error: 'filters doit contenir entre 1 et 25 filtres.' };
  const filters = [];
  let totalValues = 0;
  let locationValues = 0;
  for (const row of input) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.field !== 'string') return { error: 'Filtre invalide.' };
    const { field } = row;
    const keys = Object.keys(row).filter(key => key !== 'field');
    if (keys.length !== 1) return { error: `Un seul opérateur est permis pour ${field}.` };
    const operator = keys[0];
    if (PRESENCE_FIELDS.has(field)) {
      if (operator !== 'exists' || typeof row.exists !== 'boolean') return { error: `Le champ ${field} accepte seulement exists: true ou false.` };
      filters.push({ field, exists: row.exists });
      continue;
    }
    if (!TEXT_FIELDS.has(field) || !OPERATORS.has(operator)) return { error: `Champ ou opérateur non pris en charge : ${field}/${operator}.` };
    if (field === 'zip_code' && operator !== 'starts_with') return { error: 'zip_code utilise starts_with.' };
    if (!Array.isArray(row[operator]) || row[operator].length < 1 || row[operator].length > 30 ||
      row[operator].some(value => typeof value !== 'string' || !value.trim() || value.trim().length > 120)) {
      return { error: `Valeurs invalides pour ${field}.` };
    }
    const values = [...new Set(row[operator].map(value => value.trim()))];
    totalValues += values.length;
    if (field === 'contact_location') locationValues += values.length;
    if (totalValues > 80 || locationValues > 10) return { error: 'Trop de valeurs de filtre (80 au total, 10 localisations maximum).' };
    if (field === 'company_size' && values.some(value => !COMPANY_SIZES.has(value))) return { error: 'Tranche company_size inconnue.' };
    if (field === 'naf_code' && values.some(value => value.length !== 5)) return { error: 'naf_code doit avoir cinq caractères.' };
    filters.push({ field, [operator]: values });
  }
  return { filters };
}

export async function resolveDatabaseFilters(filters, auth) {
  const resolved = [];
  const locations = [];
  for (const filter of filters) {
    if (filter.field !== 'contact_location' || filter.exists !== undefined) {
      resolved.push(filter);
      continue;
    }
    const operator = Object.keys(filter).find(key => key !== 'field');
    const names = [];
    for (const requested of filter[operator]) {
      const response = await searchDatabaseLocations(auth, requested);
      const candidates = response.ok && Array.isArray(response.data?.locations) ? response.data.locations : [];
      const exact = candidates.find(item => fold(item.name) === fold(requested));
      const chosen = exact ?? (candidates.length === 1 ? candidates[0] : null);
      if (!chosen?.name) return { error: `Localisation « ${requested} » introuvable ou ambiguë dans la base Magileads.` };
      names.push(chosen.name);
      locations.push({ requested, used: chosen.name });
    }
    resolved.push({ field: filter.field, [operator]: names });
  }
  return { filters: resolved, locations };
}

export async function countDatabase(args, auth, profile) {
  if (!hasPermission(profile, 'displayTargetingDatabase')) return { error: 'Base Magileads non disponible pour ce compte.' };
  const valid = validateDatabaseFilters(args.filters);
  if (valid.error) return valid;
  const resolved = await resolveDatabaseFilters(valid.filters, auth);
  if (resolved.error) return resolved;
  const response = await countDatabaseTargeting(auth, resolved.filters);
  if (!response.ok) return { error: response.errorKey || 'Comptage indisponible.', status_code: response.status };
  const count = response.data?.number_of_contacts?.count;
  if (!Number.isFinite(Number(count))) return { error: 'Comptage absent de la réponse Magileads.' };
  return { count: Number(count), criteria_applied: { filters: resolved.filters, locations_resolved: resolved.locations }, note: 'Aperçu sans création de liste. Présente ce compte avant de demander la validation.' };
}

export async function runDatabase(args, auth, profile) {
  if (!hasPermission(profile, 'accessTargetingDatabase')) return { error: 'Lancement de la base Magileads non autorisé pour ce compte.' };
  const target = await resolveListTarget(args, auth);
  if (target.error) return target;
  const valid = validateDatabaseFilters(args.filters);
  if (valid.error) return valid;
  const resolved = await resolveDatabaseFilters(valid.filters, auth);
  if (resolved.error) return resolved;
  const maxResults = Math.min(Math.max(Math.trunc(Number(args.max_results)) || 100, 1), 10000);
  const response = await extractDatabaseTargeting(auth, {
    ...target.payload, max_results: maxResults, filters: resolved.filters,
    contact_list_country: null, contact_list_language: 'FRA',
  });
  const id = positiveId(response.data?.contact_list_id) ?? (response.ok ? target.id : null);
  if (!response.ok || !id) return { error: response.errorKey || 'Lancement de la base Magileads échoué.', status_code: response.status };
  return {
    status: 'extraction lancée', list_id: id, list_name: target.name,
    criteria_applied: { filters: resolved.filters, locations_resolved: resolved.locations, max_results: maxResults, ignored_filters: [] },
    note: 'Extraction asynchrone. Le compte affiché avant validation était un aperçu, pas une garantie du résultat final. Ne pas relancer.',
  };
}

export async function usableLinkedInAccount(auth, id, salesOnly = false) {
  const response = await listLinkedinAccounts(auth);
  if (!response.ok) return { error: 'Comptes LinkedIn indisponibles.' };
  const account = (response.data?.linkedin_accounts_list ?? []).find(item =>
    positiveId(item.id) === id && item.is_valid === true && item.checkpoint_required !== true &&
    (!salesOnly || item.is_sales_navigator_account === true));
  return account ? { account } : { error: salesOnly
    ? 'Compte Sales Navigator invalide, en checkpoint ou non relié à ce compte.'
    : 'Compte LinkedIn invalide, en checkpoint ou non relié à ce compte.' };
}

function industry(value) {
  if (Object.hasOwn(INDUSTRIES, value)) return { id: String(value), label: INDUSTRIES[value].fr };
  const matches = Object.entries(INDUSTRIES).filter(([, names]) =>
    fold(names.fr) === fold(value) || fold(names.en) === fold(value));
  return matches.length === 1 ? { id: matches[0][0], label: matches[0][1].fr } : null;
}

function headCount(value) {
  const candidate = fold(value) === 'independant' ? 'independant'
    : value === '10001+' ? '10001-above' : value;
  return HEAD_COUNTS.includes(candidate) ? candidate : null;
}

function seniority(value) {
  if (SENIORITY[value]) return value;
  return Object.entries(SENIORITY).find(([, label]) => fold(label) === fold(value))?.[0] ?? null;
}

function salesUrl(response) {
  const raw = response.ok ? response.data?.search_url ?? response.data?.url ?? response.data?.linkedin_url : null;
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && /(^|\.)linkedin\.com$/i.test(url.hostname) ? url.toString() : null;
  } catch { return null; }
}

function salesFingerprint(raw) {
  const url = new URL(raw);
  for (const key of [...url.searchParams.keys()]) {
    if (/^(rsLogId|logHistory|page|origin)$/i.test(key)) url.searchParams.delete(key);
  }
  url.hash = '';
  url.searchParams.sort();
  return `${url.pathname}?${url.searchParams}`;
}

export async function runSalesNavigator(args, auth, profile) {
  if (!hasPermission(profile, 'accessSearchAI')) return { error: 'Recherche Sales Navigator non autorisée pour ce compte.' };
  const accountId = positiveId(args.linkedin_account_id);
  if (!accountId) return { error: 'linkedin_account_id manquant.' };
  const validAccount = await usableLinkedInAccount(auth, accountId, true);
  if (validAccount.error) return validAccount;
  const target = await resolveListTarget(args, auth);
  if (target.error) return target;
  for (const key of ['titles', 'locations', 'industries', 'companies', 'company_head_counts', 'seniority_levels']) {
    const values = args[key];
    if (values != null && (!Array.isArray(values) || values.length > 6 || values.some(value =>
      typeof value !== 'string' || !value.trim() || value.trim().length > 120))) {
      return { error: `${key} doit être un tableau de six chaînes au maximum.` };
    }
  }
  const titles = words(args.titles, 6), requestedLocations = words(args.locations, 6);
  const companies = words(args.companies, 6), requestedIndustries = words(args.industries, 6);
  if (!requestedLocations.length || !(titles.length || companies.length || requestedIndustries.length || words(args.company_head_counts, 6).length || words(args.seniority_levels, 6).length)) {
    return { error: 'Précise une zone et au moins un critère professionnel pour Sales Navigator.' };
  }
  const locations = [], locationsResolved = [];
  for (const requested of requestedLocations) {
    const response = await searchLinkedinLocations(auth, requested);
    const candidates = response.ok && Array.isArray(response.data?.locations) ? response.data.locations : [];
    const label = item => (item.name_fr || item.name_en || '').trim();
    const exact = candidates.find(item => fold(label(item)) === fold(requested));
    const chosen = exact ?? (candidates.length === 1 ? candidates[0] : null);
    if (!chosen || !positiveId(chosen.id)) return { error: `Localisation « ${requested} » introuvable ou ambiguë sur LinkedIn.` };
    locations.push(String(chosen.id));
    locationsResolved.push({ requested, used: label(chosen), id: chosen.id });
  }
  const ignored = [];
  const payload = { current_titles: titles, locations, current_companies: companies };
  for (const [key, values, mapper] of [
    ['industries', requestedIndustries, industry],
    ['company_head_counts', words(args.company_head_counts, 6), value => headCount(value) && { id: headCount(value), label: value }],
    ['seniority_levels', words(args.seniority_levels, 6), value => seniority(value) && { id: seniority(value), label: value }],
  ]) {
    const mapped = values.map(value => ({ value, mapped: mapper(value) }));
    for (const item of mapped) if (!item.mapped) ignored.push(`${key}: « ${item.value} » non reconnu dans les valeurs de Magileads.`);
    payload[key] = mapped.filter(item => item.mapped).map(item => item.mapped.id);
  }
  const compact = object => Object.fromEntries(Object.entries(object).filter(([, value]) => Array.isArray(value) && value.length));
  // Each uncertain facet is tried against the generation endpoint. A facet that
  // leaves the URL unchanged has not been applied and must not enter extraction.
  const base = compact({ ...payload, industries: [], company_head_counts: [], seniority_levels: [] });
  let active = base;
  let url = salesUrl(await generateSalesNavSearchUrl(auth, active));
  if (!url) return { error: 'Génération de l’URL Sales Navigator échouée avant extraction.' };
  const withoutLocation = compact({ ...base, locations: [] });
  const broadUrl = salesUrl(await generateSalesNavSearchUrl(auth, withoutLocation));
  if (broadUrl && salesFingerprint(broadUrl) === salesFingerprint(url)) {
    return { error: 'La localisation demandée n’apparaît pas dans l’URL Sales Navigator générée. Extraction annulée.' };
  }
  const applied = { industries: [], company_head_counts: [], seniority_levels: [] };
  for (const key of ['industries', 'company_head_counts', 'seniority_levels']) {
    for (const value of payload[key]) {
      const candidate = compact({ ...active, [key]: [...(active[key] ?? []), value] });
      const next = salesUrl(await generateSalesNavSearchUrl(auth, candidate));
      if (next && salesFingerprint(next) !== salesFingerprint(url)) {
        active = candidate;
        url = next;
        applied[key].push(value);
      } else {
        ignored.push(`${key}: « ${value} » absent de l’URL générée ou refusé par l’API.`);
      }
    }
  }
  if (!titles.length && !companies.length && !Object.values(applied).some(values => values.length)) {
    return { error: 'Aucun critère professionnel vérifié dans l’URL Sales Navigator ; extraction annulée.', ignored_filters: ignored };
  }
  const maxResults = Math.min(Math.max(Math.trunc(Number(args.max_results)) || 100, 1), 1000);
  const generateEmail = args.generate_email !== false;
  const endpoint = hasPermission(profile, 'useAlternativeTargeting')
    ? 'extract-sales-navigator-peoples-search-alternative'
    : 'extract-sales-navigator-peoples-search';
  const response = await linkedinExtract(auth, endpoint, {
    linkedin_sales_navigator_search_url: url, linkedin_people_search_url: url,
    linkedin_account_id: accountId, generate_email: generateEmail, max_results: maxResults,
    ...target.payload, contact_list_language: null, contact_list_country: null,
    exclude_viewed_leads: false, exclude_crm_contacts: false,
  });
  const id = positiveId(response.data?.contact_list_id) ?? (response.ok ? target.id : null);
  if (!response.ok || !id) return { error: response.errorKey || 'Lancement Sales Navigator échoué.', status_code: response.status };
  return {
    status: 'extraction lancée', list_id: id, list_name: target.name,
    criteria_applied: {
      titles, locations: locationsResolved, companies,
      industries: applied.industries.map(value => ({ id: value, name: INDUSTRIES[value]?.fr ?? value })),
      company_head_counts: applied.company_head_counts, seniority_levels: applied.seniority_levels,
      linkedin_account_id: accountId, max_results: maxResults, generate_email: generateEmail,
      ignored_filters: ignored,
    },
    note: `Extraction asynchrone. ${ignored.length ? `Filtres ignorés : ${ignored.join(' ')}` : 'Tous les filtres acceptés ont été appliqués.'} Ne pas relancer.`,
  };
}
