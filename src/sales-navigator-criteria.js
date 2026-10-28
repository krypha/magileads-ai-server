export const SALES_HEAD_COUNTS = ['independant', '1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001-10000', '10001-above'];
export const SALES_SENIORITY = ['in_training', 'entry_level', 'senior', 'strategic', 'entry_level_manager', 'experienced_manager', 'director', 'vice_president', 'cxo', 'owner_partner'];
export const SALES_ARRAY_FIELDS = {
  company_head_counts: 'Effectifs de l’entreprise : tranches exactes du catalogue.',
  company_headquarters: 'Localisation du siège des entreprises, distincte du lieu de résidence des personnes.',
  job_titles_exclude: 'Postes actuels à exclure.',
  locations_exclude: 'Localisations des personnes à exclure.',
  sectors_exclude: 'Secteurs à exclure : noms exacts ou IDs du catalogue.',
  seniority_exclude: 'Niveaux hiérarchiques à exclure, mêmes valeurs que seniority.',
  companies_exclude: 'Entreprises actuelles à exclure.',
  company_headquarters_exclude: 'Localisations de sièges d’entreprise à exclure.',
};
export const SALES_FLAGS = {
  recently_changed_job: 'Personnes ayant récemment changé de poste.',
  posted_on_linkedin: 'Personnes ayant publié sur LinkedIn.',
  in_the_news: 'Personnes dans l’actualité.',
};
export const SALES_TOOL_FIELDS = {
  company_head_counts: 'company_head_counts', company_headquarters: 'company_headquarters',
  job_titles_exclude: 'titles_exclude', locations_exclude: 'locations_exclude',
  sectors_exclude: 'industries_exclude', seniority_exclude: 'seniority_levels_exclude',
  companies_exclude: 'companies_exclude', company_headquarters_exclude: 'company_headquarters_exclude',
};
export const salesArraySchema = (description, key) => ({ type: 'array', maxItems: key === 'company_head_counts' ? 9 : 6, items: { type: 'string', ...(key === 'company_head_counts' ? { enum: SALES_HEAD_COUNTS } : {}) }, description });
export const SALES_CRITERIA_SCHEMA = Object.fromEntries([
  ...Object.entries(SALES_ARRAY_FIELDS).map(([key, text]) => [key, salesArraySchema(text, key)]),
  ...Object.entries(SALES_FLAGS).map(([key, text]) => [key, { type: ['boolean', 'null'], description: `${text} true = activer, false/null = aucun filtre.` }]),
]);
export const SALES_RUN_SCHEMA = Object.fromEntries([
  ...Object.entries(SALES_ARRAY_FIELDS).map(([key, text]) => [SALES_TOOL_FIELDS[key], salesArraySchema(text, key)]),
  ...Object.entries(SALES_FLAGS).map(([key, text]) => [key, { type: ['boolean', 'null'], description: `${text} true = activer, false/null = désactiver.` }]),
]);
export function normalizedSalesCriteria(input) {
  const result = {};
  for (const key of Object.keys(SALES_ARRAY_FIELDS)) if (Object.hasOwn(input, key)) result[key] = Array.isArray(input[key])
    ? [...new Set(input[key].filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean))] : [];
  for (const key of Object.keys(SALES_FLAGS)) if (Object.hasOwn(input, key)) result[key] = typeof input[key] === 'boolean' ? input[key] : null;
  return result;
}
export function salesCriteriaErrors(input) {
  const errors = [];
  for (const key of Object.keys(SALES_ARRAY_FIELDS)) {
    if (input[key] != null && (!Array.isArray(input[key]) || input[key].length > (key === 'company_head_counts' ? 9 : 6) || input[key].some(x => typeof x !== 'string' || !x.trim() || x.length > 120))) errors.push(`Corriger le critère ${key} : six valeurs de 120 caractères maximum.`);
  }
  for (const key of Object.keys(SALES_FLAGS)) if (input[key] != null && typeof input[key] !== 'boolean') errors.push(`Corriger le signal ${key} : vrai, faux ou aucun filtre.`);
  return errors;
}
export function headCountsForCriteria(criteria) {
  if (criteria.company_head_counts?.length) return criteria.company_head_counts;
  if (criteria.company_size_min == null && criteria.company_size_max == null) return [];
  const low = criteria.company_size_min ?? 0, high = criteria.company_size_max ?? Infinity;
  const ranges = [[0,0],[1,10],[11,50],[51,200],[201,500],[501,1000],[1001,5000],[5001,10000],[10001,Infinity]];
  return SALES_HEAD_COUNTS.filter((_, i) => ranges[i][1] >= low && ranges[i][0] <= high);
}
export function hasSalesTarget(criteria) {
  return ['job_titles','locations','companies','sectors','seniority','company_headquarters'].some(key => criteria[key]?.length) ||
    headCountsForCriteria(criteria).length > 0 || Object.keys(SALES_FLAGS).some(key => criteria[key] === true);
}
