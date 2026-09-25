// Defence in depth: this policy applies to every result, before the model or UI.
const SECRET = /password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential/i;
// These account/list diagnostics make campaign audits misleading. Never put
// their values in the model context or in cards, regardless of nesting.
const HIDDEN = /^(?:bad_emails?|invalid_emails?|invalid_addresses|bad_addresses|number_of_bad_emails|number_of_invalid_emails|bounced|contact_email_bounce|unsubscribers?|number_of_unsubscribers?|contacts_without_required_data|contacts_without_email|number_of_contacts_without_email)$/i;
const HIDDEN_DIAGNOSTIC = /contacts_without_required_data|contacts?\s+(?:ne\s+contien(?:nent|t)\s+pas\s+d['’]?e-?mail|without\s+(?:an?\s+)?e-?mail)|(?:d[ée]sabonn[ée]s|mauvaises?\s+adresses?)\s+dans\s+les\s+listes/i;
const HISTORY_METRIC = /\b(?:unsubscribers?|bounced|contact_email_bounce|contacts_without_required_data|bad[_ ]addresses|invalid[_ ]emails)\b|(?:d[ée]sabonn[ée]s|mauvaises?\s+adresses?)\s+dans\s+les\s+listes|(?:ne\s+contiennent\s+pas\s+d['’]?e-?mail)/i;
/** Old answers can contain figures produced before the filter was installed. */
export function redactHiddenAuditText(text) {
  return text.split(/\r?\n/).filter(line => !HISTORY_METRIC.test(line)).join('\n');
}
export function sanitize(value, listContext = false) {
  if (typeof value === 'string' && HIDDEN_DIAGNOSTIC.test(value)) return undefined;
  if (Array.isArray(value)) return value.map(item => sanitize(item, listContext)).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  // Campaign step diagnostics carry the count under `message.replacements`.
  // Drop the whole diagnostic, not just its display string.
  const message = value.message && typeof value.message === 'object' ? value.message : value;
  if (typeof message.key === 'string' && HIDDEN_DIAGNOSTIC.test(message.key)) return undefined;
  if (typeof message.translation === 'string' && HIDDEN_DIAGNOSTIC.test(message.translation)) return undefined;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SECRET.test(key) && !HIDDEN.test(key) && !(listContext && /bounce|bad_address|invalid_address/i.test(key)))
    .map(([key, item]) => [key, sanitize(item, listContext || /^(contact_lists?|contact_list_profile|lists)$/i.test(key))])
    .filter(([, item]) => item !== undefined));
}
export function hasSecret(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => SECRET.test(key) || hasSecret(item));
}
export function forbiddenOperation(name) {
  return /(^|[_/])(delete|remove|destroy|purge|erase|truncate|deduplicate)([_/]|$)/i.test(name);
}
