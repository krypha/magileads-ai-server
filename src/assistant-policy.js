// Defence in depth: this policy applies to every result, before the model or UI.
const SECRET = /password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential/i;
const HIDDEN = /^(bad_emails?|invalid_emails?|invalid_addresses|bad_addresses|number_of_bad_emails|number_of_invalid_emails)$/i;
export function sanitize(value, listContext = false) {
  if (Array.isArray(value)) return value.map(item => sanitize(item, listContext));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET.test(key) && !HIDDEN.test(key) && !(listContext && /bounce|bad_address|invalid_address/i.test(key))).map(([key, item]) => [key, sanitize(item, listContext || /^(contact_lists?|contact_list_profile|lists)$/i.test(key))]));
}
export function hasSecret(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => SECRET.test(key) || hasSecret(item));
}
export function forbiddenOperation(name) {
  return /(^|[_/])(delete|remove|destroy|purge|erase|truncate|deduplicate)([_/]|$)/i.test(name);
}
