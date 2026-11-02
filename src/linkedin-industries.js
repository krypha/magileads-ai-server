import { readFileSync } from 'node:fs';

// Same ID/label catalog as the v4 LinkedIn selector. No caller data or secrets.
export const LINKEDIN_INDUSTRIES = JSON.parse(readFileSync(new URL('./linkedin-industries.json', import.meta.url), 'utf8'));
const fold = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const entries = Object.entries(LINKEDIN_INDUSTRIES).map(([id, names]) => ({ id, name_fr: names.fr, name_en: names.en }));

export function resolveLinkedinIndustry(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const key = fold(value);
  const exact = entries.filter(item => item.id === value.trim() || fold(item.name_fr) === key || fold(item.name_en) === key);
  const matches = exact.length ? exact : key.length >= 3 ? entries.filter(item =>
    fold(item.name_fr).startsWith(key) || fold(item.name_en).startsWith(key)) : [];
  return matches.length === 1 ? { id: matches[0].id, label: matches[0].name_fr } : null;
}

// Synonyms help DISCOVER candidates; they never authorize automatic mapping.
const searchTerms = {
  saas: ['logiciel', 'software'], esn: ['informatique', 'it services'],
  btp: ['construction', 'batiment', 'civil engineering'],
  rh: ['recrutement', 'ressources humaines', 'human resources'],
  sante: ['sante', 'health', 'hospital', 'pharmac'],
};
const stopWords = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'un', 'une', 'et', 'dans', 'secteur', 'activite', 'the', 'and', 'of', 'industry']);
export function searchLinkedinIndustries(query = '') {
  if (typeof query !== 'string' || query.length > 120) return { error: 'Précise un secteur en 120 caractères maximum.' };
  const key = fold(query);
  const resolved = resolveLinkedinIndustry(query);
  const tokens = key.split(' ').filter(token => token.length >= 2 && !stopWords.has(token));
  const terms = [...new Set(tokens.flatMap(token => searchTerms[token] ?? [token]))];
  const scored = entries.map(item => {
    const names = [fold(item.name_fr), fold(item.name_en)];
    return { item, score: item.id === resolved?.id ? 1000 : terms.reduce((score, term) => score + (names.some(name => name.includes(term)) ? 1 : 0), 0) };
  }).filter(row => !key || row.score > 0).sort((a, b) => b.score - a.score || Number(a.item.id) - Number(b.item.id));
  const industries = scored.slice(0, key ? 25 : entries.length).map(row => row.item);
  return {
    query, ...(resolved ? { match: entries.find(item => item.id === resolved.id) } : {}),
    industries, total: scored.length,
    note: 'Vrais secteurs LinkedIn. Sélectionne le libellé exact adapté à la demande et enregistre-le dans sectors ou sectors_exclude via update_targeting. Si le sens reste ambigu ou sans correspondance, demande un seul choix à l’utilisateur parmi ces libellés ; ne choisis pas le premier et ne supprime pas le critère. Une recherche vide donne tout le catalogue pour rechercher une autre formulation. Ne confonds pas un métier avec le secteur de l’entreprise.',
  };
}

export function resolveLinkedinIndustries(values = [], field = 'industries') {
  if (!Array.isArray(values) || values.length > 6 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 120)) {
    return { error: 'Secteurs : six libellés ou IDs LinkedIn de 120 caractères maximum.', error_key: 'invalid_linkedin_industries' };
  }
  const matches = values.map(resolveLinkedinIndustry);
  const unresolved = values.flatMap((value, index) => matches[index] ? [] : [{ requested: value, candidates: searchLinkedinIndustries(value).industries }]);
  if (unresolved.length) return {
    error: 'Choisir un secteur d’activité LinkedIn avant de lancer la recherche.',
    error_key: 'linkedin_industry_choice_required', field, requires_user_choice: true, unresolved,
    note: 'Demande à l’utilisateur quel secteur LinkedIn choisir parmi les vrais libellés proposés. Si aucun ne convient, reformule la recherche dans le catalogue. Aucun filtre ne doit être ignoré et aucune extraction ne doit être lancée.',
  };
  return { industries: [...new Map(matches.map(item => [item.id, item])).values()] };
}

/** Check the actual LinkedIn INDUSTRY facet, not incidental URL changes. */
export function salesNavigatorIndustriesApplied(raw, included, excluded) {
  let query;
  try { query = new URL(raw).searchParams.get('query') ?? ''; } catch { return false; }
  const marker = 'type:INDUSTRY,values:List(';
  const start = query.indexOf(marker);
  if (start < 0) return false;
  let depth = 1, end = start + marker.length;
  const contentStart = end;
  for (; end < query.length && depth; end++) {
    if (query[end] === '(') depth++;
    if (query[end] === ')') depth--;
  }
  if (depth !== 0) return false;
  const facet = query.slice(contentStart, end - 1);
  const values = [...facet.matchAll(/\(id:(\d+),selectionType:(INCLUDED|EXCLUDED)\)/g)];
  return included.every(id => values.some(value => value[1] === String(id) && value[2] === 'INCLUDED')) &&
    excluded.every(id => values.some(value => value[1] === String(id) && value[2] === 'EXCLUDED'));
}
