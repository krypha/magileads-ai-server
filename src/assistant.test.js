import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_TOOLS, executeTool } from './tools.js';
import { OPERATIONS, executeExtended } from './operations.js';
import { redactHiddenAuditText, sanitize } from './assistant-policy.js';
import { cardsForTool } from './cards.js';
import { request } from './magileads.js';

const auth = { accessToken: 'test-token-never-forwarded-to-model' };
test('no deletion tool advertised, and direct legacy calls cannot reach the API', async () => {
  const previous = global.fetch;
  global.fetch = () => { throw new Error('must not fetch'); };
  try {
    assert.ok(!AI_TOOLS.some(tool => /delete|remove|purge/.test(tool.function.name)));
    for (const name of ['delete_contacts_by_selection', 'remove_contact', 'purge_list', 'unknown']) {
      assert.equal(JSON.parse(await executeTool(name, '{}', auth)).error, 'operation_not_allowed');
    }
    assert.equal((await request('/contact-lists/1', { auth, method: 'DELETE' })).errorKey, 'deletion_disabled');
    assert.equal((await executeExtended('run_operation', { operation: 'delete_contact_list' }, auth)).error, 'operation_not_allowed');
  } finally { global.fetch = previous; }
});
test('duplicate uses the caller identity, verified route and returns the new ID', async () => {
  const previous = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, '/contact-lists/42/copy');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, `Bearer ${auth.accessToken}`);
    return Response.json({ state: true, contact_list_id: 43 });
  };
  try {
    const result = await executeTool('run_operation', JSON.stringify({ operation: 'duplicate_contact_list', params: { id: 42 } }), auth);
    assert.equal(JSON.parse(result).data.contact_list_id, 43);
    assert.deepEqual(cardsForTool('run_operation', result, '{"operation":"duplicate_contact_list"}'), [{ kind: 'result', operation: 'duplicate_contact_list', id: 43 }]);
    assert.ok(!result.includes(auth.accessToken));
  } finally { global.fetch = previous; }
});
test('Dropcontact exposes only key names and IDs; launches with a verified connection', async () => {
  const previous = global.fetch;
  let calls = 0;
  global.fetch = async (url, options) => {
    calls++;
    if (new URL(url).pathname === '/external-api-keys') return Response.json({ state: true, external_api_keys_list: [{ id: 5, type: 'dropcontact', name: 'Team', api_key: 'secret-value' }, { id: 6, type: 'kaspr', api_key: 'other-secret' }] });
    assert.equal(new URL(url).pathname, '/contact-lists/42/enrich/external/dropcontact/5');
    assert.equal(options.method, 'POST');
    return Response.json({ state: true });
  };
  try {
    const keys = await executeTool('list_dropcontact_connections', '{}', auth);
    assert.deepEqual(JSON.parse(keys), { connections: [{ id: 5, name: 'Team' }] });
    const result = await executeExtended('run_operation', { operation: 'enrich_dropcontact', params: { id: 42, key_id: 5 }, body: { filter: { mode: 'and', values: [] } } }, auth);
    assert.equal(result.status, 'accepted');
    assert.equal(calls, 3);
  } finally { global.fetch = previous; }
});
test('invalid IDs, URL injection, arbitrary bodies and credentials are rejected before fetch', async () => {
  const previous = global.fetch;
  global.fetch = () => { throw new Error('must not fetch'); };
  try {
    for (const id of [0, -1, 'https://evil.test', '../1', '1?method=DELETE']) {
      assert.equal((await executeExtended('run_operation', { operation: 'duplicate_contact_list', params: { id } }, auth)).error, 'invalid_resource_id');
    }
    assert.equal((await executeExtended('run_operation', { operation: 'update_contact_list', params: { id: 1 }, body: { delete: true } }, auth)).error, 'invalid_body');
    assert.equal((await executeExtended('run_operation', { operation: 'update_contact', params: { id: 1, contact_id: 2 }, body: { properties: { password: 'secret' } } }, auth)).error, 'invalid_arguments');
  } finally { global.fetch = previous; }
});
test('HTTP 200 with state false is a failure, never a success card', async () => {
  const previous = global.fetch;
  global.fetch = async () => Response.json({ state: false, state_message: 'permission_denied' });
  try {
    const result = await executeTool('run_operation', '{"operation":"duplicate_contact_list","params":{"id":42}}', auth);
    assert.equal(JSON.parse(result).error, 'permission_denied');
    assert.deepEqual(cardsForTool('run_operation', result, '{"operation":"duplicate_contact_list"}'), []);
  } finally { global.fetch = previous; }
});
test('audit diagnostics and their numeric replacements never reach the model', () => {
  const raw = { contacted: 5000, bounced: 2525, contact_email_bounce: 2525,
    unsubscribers: 557, invalid_emails: 2525, contact_lists: [{ id: 5, bounced: 2525 }],
    steps: [{ contacted: 100, details: [
      { level: 'warning', message: { key: ':contacts_without_required_data contacts without required data :email', replacements: { contacts_without_required_data: 13896 } } },
      { level: 'info', message: { key: 'Sendings ended', translation: 'Envois terminés' } },
    ] }],
    nested: [{ smtp_password: 'secret', refresh_token: 'secret', api_key: 'secret', name: 'OK' }] };
  const clean = sanitize(raw);
  assert.equal(clean.contacted, 5000);
  assert.deepEqual(clean.steps[0].details, [{ level: 'info', message: { key: 'Sendings ended', translation: 'Envois terminés' } }]);
  assert.deepEqual(clean.contact_lists, [{ id: 5 }]);
  assert.deepEqual(clean.nested, [{ name: 'OK' }]);
  for (const count of ['557', '13896', '2525']) assert.ok(!JSON.stringify(clean).includes(count));
  assert.equal(redactHiddenAuditText('Réponses : 40\nDésabonnés dans les listes : 557\nMauvaises adresses dans les listes : 2 525'), 'Réponses : 40');
});
test('email connection is a frontend-only action with no API request', async () => {
  const previous = global.fetch;
  global.fetch = () => { throw new Error('must not fetch'); };
  try {
    const result = await executeTool('connect_email', '{}', auth);
    assert.equal(JSON.parse(result).status, 'awaiting_user');
    assert.deepEqual(cardsForTool('connect_email', result), [{ kind: 'email' }]);
  } finally { global.fetch = previous; }
});
test('catalog has unique names and no deletion routes/methods', () => {
  assert.equal(new Set(OPERATIONS.map(op => op.name)).size, OPERATIONS.length);
  assert.ok(OPERATIONS.every(op => ['GET', 'POST', 'PUT'].includes(op.method) && !/delete|remove|purge/.test(op.path)));
});
