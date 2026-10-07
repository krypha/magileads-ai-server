/** LinkedIn URL codes: F = first, S = second, O = third+. No new API fields. */
const CODES = { 1: 'F', 2: 'S', 3: 'O' };
export const CONNECTION_DEGREES_SCHEMA = {
  type: 'array', maxItems: 3, uniqueItems: true, items: { type: 'integer', enum: [1, 2, 3] },
  description: 'Niveaux de connexion : 1 = relations directes (1er niveau), 2 = deuxième, 3 = troisième et plus. [] = tous. Relatif au compte LinkedIn choisi, pas au niveau hiérarchique.',
};
export function validConnectionDegrees(value) {
  return value == null || (Array.isArray(value) && value.length <= 3 && value.every(item => [1, 2, 3].includes(item)));
}
export function normalizeConnectionDegrees(value) {
  return validConnectionDegrees(value) && Array.isArray(value) ? [...new Set(value)].sort() : [];
}
// Split a Rest.li filter list without losing nested title/location facets.
function listContents(query, start) {
  let depth = 0, from = start;
  const items = [];
  for (let i = start; i < query.length; i++) {
    const char = query[i];
    if (char === '(') depth++;
    if (char === ')') {
      if (depth === 0) {
        if (query.slice(from, i).trim()) items.push(query.slice(from, i));
        return { items, end: i };
      }
      depth--;
    }
    if (char === ',' && depth === 0) { items.push(query.slice(from, i)); from = i + 1; }
  }
  return null;
}
/** Apply reviewed degrees to the URL sent to extraction; refuse unknown formats. */
export function applyConnectionDegrees(raw, requested, salesNavigator = false) {
  if (!validConnectionDegrees(requested)) return { error: 'Le niveau de connexion doit être un tableau contenant uniquement 1, 2 ou 3.' };
  const degrees = normalizeConnectionDegrees(requested);
  if (!degrees.length) return { url: raw, degrees };
  let url;
  try { url = new URL(raw); } catch { return { error: 'URL LinkedIn invalide ; niveau de connexion non appliqué, extraction annulée.' }; }
  if (url.protocol !== 'https:' || !/(^|\.)linkedin\.com$/i.test(url.hostname)) return { error: 'URL LinkedIn invalide ; extraction annulée.' };
  if (!salesNavigator) {
    if (!/^\/search\/results\/people\/?$/.test(url.pathname)) return { error: 'Format de recherche LinkedIn inconnu ; niveau de connexion non appliqué, extraction annulée.' };
    url.searchParams.set('network', JSON.stringify(degrees.map(degree => CODES[degree])));
  } else {
    const query = url.searchParams.get('query');
    const match = query?.match(/(?:^|[(,])filters:List\(/);
    const start = match ? match.index + match[0].length : null;
    const list = start != null ? listContents(query, start) : null;
    if (!/^\/sales\/search\/people\/?$/.test(url.pathname) || !list) return { error: 'Format de recherche Sales Navigator inconnu ; niveau de connexion non appliqué, extraction annulée.' };
    const others = list.items.filter(item => !/^\(type:RELATIONSHIP(?:,|\))/.test(item.trim()));
    const values = degrees.map(degree => `(id:${CODES[degree]},selectionType:INCLUDED)`).join(',');
    others.push(`(type:RELATIONSHIP,values:List(${values}))`);
    url.searchParams.set('query', query.slice(0, start) + others.join(',') + query.slice(list.end));
  }
  return { url: url.toString(), degrees };
}
