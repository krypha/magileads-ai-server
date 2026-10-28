/** Keep legacy scalar callers working; a submitted array is authoritative, even empty. */
export function linkedinValues(multiple, single) {
  if (multiple != null) {
    if (!Array.isArray(multiple) || multiple.length > 6 || multiple.some(value => typeof value !== 'string' || !value.trim() || value.trim().length > 120)) return null;
    return [...new Set(multiple.map(value => value.trim()))];
  }
  if (single == null || single === '') return [];
  if (typeof single !== 'string' || !single.trim() || single.trim().length > 120) return null;
  return [single.trim()];
}

/** OR within a dimension; the generator combines job, employer and geography. */
export function linkedinBooleanOr(values) {
  return values.length > 1 ? values.map(value => JSON.stringify(value)).join(' OR ') : values[0] ?? '';
}
