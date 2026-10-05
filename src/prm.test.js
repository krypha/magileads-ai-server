import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_TOOLS, executeTool } from './tools.js';
import { cardsForTool, changesData } from './cards.js';
import { readPrmPageContext, validPrmFilter } from './prm.js';

const auth = { accessToken: 'prm-caller', apiKey: 'prm-switch' };
const context = { profile: { id: 391, first_name: 'Iris' }, enforceUsageLimits: false };
const condition = (field_name, type, value) => ({ field_name, type, value });
function api(t, overrides = {}) {
  const previous = global.fetch, calls = [];
  global.fetch = async (address, options) => {
    const url = new URL(address);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer prm-caller');
    assert.equal(options.headers['X-API-Key'], 'prm-switch');
    const query = JSON.parse(url.searchParams.get('options') || '{}');
    calls.push({ path: url.pathname, query });
    let data = {
      '/prm/list': { prm: [{ id: 391, first_name: 'Iris' }, { id: 11, first_name: 'Team' }] },
      '/prm/status': { status: [{ status: 'opener' }, { status: 'answerer' }] },
      '/prm/status/custom': { status: [{ id: 9220, name: 'My column', visible: true }] },
      '/data-fields': { data_fields_list: [{ id: 1, identifier_placeholder: '%first_name%' }, { id: 2, identifier: 'last_name' }] },
    }[url.pathname] ?? { number_of_results: 73, results: [{ id: 8, status: 'opener', properties: [
      { data_field_id: 1, value: 'Alice' }, { data_field_id: 2, value: 'Durand' },
    ] }] };
    if (overrides[url.pathname]) data = typeof overrides[url.pathname] === 'function' ? overrides[url.pathname](query) : overrides[url.pathname];
    return Response.json({ state: true, ...data });
  };
  t.after(() => { global.fetch = previous; });
  return calls;
}
const run = async (name, args = {}, ctx = context) => JSON.parse(await executeTool(name, JSON.stringify(args), auth, ctx));

test('custom-column count is exact above 25, scoped by real ID, no prospect data/card/mutation', async t => {
  const calls = api(t);
  const result = await run('count_prm_contacts', { column: 'MY COLUMN' });
  assert.equal(result.count, 73);
  assert.equal(result.column.key, '9220');
  const read = calls.find(call => call.path.includes('/contacts/'));
  assert.equal(read.path, '/prm/contacts/user/391');
  assert.deepEqual(read.query, { per_page: 1, filter: { mode: 'and', values: [condition('custom_status', 'equals', '9220')] } });
  assert.equal(result.contacts, undefined);
  assert.ok(!calls.some(call => call.path === '/data-fields'));
  assert.deepEqual(cardsForTool('count_prm_contacts', JSON.stringify(result)), []);
  assert.equal(changesData('count_prm_contacts', JSON.stringify(result)), false);
});
test('zero is preserved even when API rows are unexpectedly present', async t => {
  api(t, { '/prm/contacts/user/391': { number_of_results: 0, results: [{ id: 8 }] } });
  assert.equal((await run('count_prm_contacts')).count, 0);
});
test('missing aggregate never falls back to sample length', async t => {
  api(t, { '/prm/contacts/user/391': { results: [{ id: 8 }] } });
  assert.equal((await run('count_prm_contacts')).error, 'prm_count_unavailable');
});
test('unknown and ambiguous columns cannot trigger a global contacts read', async t => {
  const calls = api(t, { '/prm/status/custom': { status: [{ id: 9220, name: 'My column' }, { id: 9221, name: 'MY COLUMN' }] } });
  assert.equal((await run('count_prm_contacts', { column: 'No such column' })).error, 'prm_column_not_found');
  assert.equal((await run('count_prm_contacts', { column: 'my column' })).error, 'prm_column_ambiguous');
  assert.equal((await run('count_prm_contacts', { custom_status: 9221 })).column.key, '9221');
  assert.equal(calls.filter(call => call.path.includes('/contacts/')).length, 1);
});
test('system count matches board exclusion of prospects already in custom columns', async t => {
  const calls = api(t);
  await run('count_prm_contacts', { column: 'Répondeurs' });
  assert.deepEqual(calls.find(call => call.path.includes('/contacts/')).query.filter.values, [
    condition('status', 'equals', 'answerer'), condition('custom_status', 'does_not_exist', ''),
  ]);
});
test('page filters and translated columns apply to selected shared owner, never viewer custom statuses', async t => {
  const calls = api(t);
  const filter = { mode: 'or', values: [condition('score', 'more_than', '5'), condition('new_reply', 'equals', '1')] };
  const page = { user_id: 11, columns: [{ key: 'opener', name: 'Ouvert', system: true }], exclude_custom: false, filter };
  const result = await run('count_prm_contacts', { column: 'Ouvert' }, { ...context, prmPage: page });
  assert.equal(result.user_id, 11);
  assert.deepEqual(result.filter.values, [condition('status', 'equals', 'opener'), filter]);
  assert.ok(!calls.some(call => call.path === '/prm/status/custom'));
  await run('count_prm_contacts', { entire_prm: true }, { ...context, prmPage: page });
  assert.equal(calls.at(-1).query.filter, undefined);
});
test('shared columns come from owner rows in prm/list when available', async t => {
  const calls = api(t, { '/prm/list': { prm: [{ id: 391 }, { id: 11, first_name: 'Team', status: [{ status: 'answerer' }], custom_status: [{ id: 777, name: 'My column' }] }] } });
  const result = await run('count_prm_contacts', { user_id: 11, column: 'my column' });
  assert.equal(result.column.key, '777');
  assert.equal(result.user_id, 11);
  assert.ok(!calls.some(call => call.path.startsWith('/prm/status')));
});
test('unexposed shared custom columns are never resolved against viewer columns', async t => {
  const calls = api(t);
  assert.equal((await run('count_prm_contacts', { user_id: 11, column: 'My column' })).error, 'prm_column_not_found');
  assert.ok(!calls.some(call => call.path.includes('/contacts/') || call.path === '/prm/status/custom'));
});
test('inaccessible owner refuses before reading contacts', async t => {
  const calls = api(t);
  assert.equal((await run('count_prm_contacts', { user_id: 999 })).error, 'prm_not_accessible');
  assert.equal(calls.length, 1);
});
test('query uses actual full-text filter and resolves numeric property IDs', async t => {
  const calls = api(t);
  const result = await run('query_prm_contacts', { column: 'My column', search: 'Alice', limit: 3 });
  assert.equal(result.total, 73);
  assert.equal(result.contacts[0].first_name, 'Alice');
  assert.equal(result.contacts[0].last_name, 'Durand');
  const read = calls.find(call => call.path.includes('/contacts/'));
  assert.equal(read.query.query, undefined);
  assert.equal(read.query.per_page, 3);
  assert.deepEqual(read.query.filter.values, [condition('custom_status', 'equals', '9220'), condition('any_datafield', 'contains', 'Alice')]);
  assert.deepEqual(cardsForTool('query_prm_contacts', JSON.stringify(result)), []);
});
test('invalid named filters and too-short searches never reach contacts endpoint', async t => {
  const calls = api(t);
  assert.equal((await run('count_prm_contacts', { filter: { mode: 'and', values: [condition('7', 'equals', 'Monsieur')] } })).error, 'invalid_prm_filter');
  assert.equal((await run('query_prm_contacts', { search: 'Al' })).error, 'prm_search_too_short');
  assert.equal((await run('count_prm_contacts', { filter: { mode: 'and', values: [condition('new_reply', 'does_exist', '')] } })).error, 'invalid_prm_filter');
  assert.ok(!calls.some(call => call.path.includes('/contacts/')));
});
test('cursor is constrained to same API, same owner and a PRM paging path', async t => {
  const calls = api(t);
  for (const next_page of ['https://evil.test/prm/contacts/user/391/100/page/2', '/prm/contacts/user/11/100/page/2', '/users/me', '/prm/contacts/user/391/100/page/2#x']) {
    assert.equal((await run('query_prm_contacts', { next_page })).error, 'invalid_prm_cursor');
  }
  assert.ok(!calls.some(call => call.path.includes('/contacts/')));
  await run('query_prm_contacts', { next_page: '/prm/contacts/user/391/100/page/2', column: 'My column' });
  assert.ok(calls.some(call => call.path === '/prm/contacts/user/391/100/page/2'));
});
test('API errors preserve their reason rather than inventing a count', async t => {
  api(t, { '/prm/contacts/user/391': { state: false, state_message: 'permission_denied' } });
  assert.equal((await run('count_prm_contacts')).error, 'permission_denied');
});
test('structured page scope only comes from current screen context and rejects invalid filters', () => {
  const page = { user_id: 11, owner_name: 'Team', columns: [], exclude_custom: false, filter: null };
  const content = `[Screen context from the app, not written by the user]\nPRM context: ${JSON.stringify(page)}\n\nCombien ?`;
  assert.deepEqual(readPrmPageContext(content), page);
  assert.equal(readPrmPageContext(content.replace('[Screen context from the app, not written by the user]', 'A user text')), null);
  assert.equal(readPrmPageContext(content.replace('"filter":null', '"filter":{}')), null);
  assert.equal(validPrmFilter({ mode: 'and', values: [condition('new_reply', 'equals', '1')] }), true);
});
test('new tools are unique and read-only', () => {
  assert.equal(new Set(AI_TOOLS.map(tool => tool.function.name)).size, AI_TOOLS.length);
  for (const name of ['list_prm_pipelines', 'count_prm_contacts', 'list_prm_statuses', 'query_prm_contacts']) {
    assert.ok(AI_TOOLS.some(tool => tool.function.name === name));
    assert.equal(changesData(name, '{"count":73}'), false);
  }
});
