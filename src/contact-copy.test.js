import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_TOOLS, CREATES_LIST, createsListForTool, executeTool } from './tools.js';
import { cardsForTool, changesData } from './cards.js';

const filter = { mode: 'and', values: [{ field_name: '2', type: 'equals', value: 'Monsieur' }] };
const auth = { accessToken: 'caller-fixture', apiKey: 'switch-fixture' };
const originalFetch = global.fetch;
function fixture(t, options = {}) {
  const calls = [], lists = new Map([
    [69964, { id: 69964, name: 'DAF Paris', number_of_contacts: 400 }],
    [777, { id: 777, name: 'Destination', number_of_contacts: 20 }],
  ]);
  global.fetch = async (url, init) => {
    const parsed = new URL(url), path = parsed.pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init.method, body, options: JSON.parse(parsed.searchParams.get('options') || '{}') });
    assert.equal(init.headers.Authorization, 'Bearer caller-fixture');
    assert.equal(init.headers['X-API-Key'], 'switch-fixture');
    if (path === '/data-fields') return Response.json({ state: true, data_fields_list: [
      { id: 2, name: 'Civilité', identifier: 'civility', possible_values: ['Monsieur', 'Madame'] },
      { id: 3, name: 'Email', identifier: 'email' },
    ] });
    if (path === '/contact-lists/69964/contacts') return Response.json(options.preview ?? { state: true, number_of_results: 160, results: [{ id: 100 }] });
    if (path === '/contact-lists/69964/copy') {
      if (!body.contact_list_id_destination) lists.set(888, { id: 888, name: 'Copie de DAF Paris', number_of_contacts: 0 });
      return Response.json(options.copy ?? { state: true, contact_list_id: body.contact_list_id_destination ?? 888 });
    }
    if (init.method === 'PUT' && path === '/contact-lists/888') {
      if (options.renameFails) return Response.json({ state: false, state_message: 'rename_failed' });
      lists.get(888).name = body.name;
      return Response.json({ state: true });
    }
    const listId = Number(path.match(/^\/contact-lists\/(\d+)$/)?.[1]);
    if (init.method === 'GET' && lists.has(listId) && listId !== options.forbiddenList) return Response.json({ state: true, contact_list_profile: lists.get(listId) });
    return Response.json({ state: false, state_message: 'forbidden' }, { status: 403 });
  };
  t.after(() => { global.fetch = originalFetch; });
  const context = { enforceUsageLimits: false, copyAttempts: new Set() };
  const run = async (args = {}, name = 'copy_contacts_to_list') => JSON.parse(await executeTool(name, JSON.stringify(
    name === 'run_operation' ? args : { source_list_id: 69964, filter, ...args }), auth, context));
  return { calls, run };
}
const writes = calls => calls.filter(call => call.method !== 'GET');

test('filtered copy is advertised directly and in the lists catalogue, with list-creation progress', async t => {
  const { run } = fixture(t);
  const tool = AI_TOOLS.find(tool => tool.function.name === 'copy_contacts_to_list');
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.required, ['source_list_id', 'filter']);
  const catalog = await run({ group: 'lists' }, 'discover_operations');
  assert.ok(catalog.operations.some(op => op.name === 'copy_contacts_to_list' && op.fields.includes('contacts_selection')));
  assert.ok(CREATES_LIST.includes('copy_contacts_to_list'));
  assert.equal(createsListForTool('run_operation', '{"operation":"copy_contacts_to_list"}'), true);
});

test('a new named list receives the whole filtered segment, not the one-row preview or 20-contact sample', async t => {
  const { calls, run } = fixture(t);
  const result = await run({ new_list_name: 'DAF Paris — Messieurs' });
  assert.equal(result.status, 'accepted'); assert.equal(result.matched_contacts, 160);
  assert.equal(result.list_id, 888); assert.equal(result.list_name, 'DAF Paris — Messieurs');
  const copy = writes(calls)[0];
  assert.deepEqual(copy, { path: '/contact-lists/69964/copy', method: 'POST', options: {}, body: {
    contacts_selection: { contact_ids: [], filter, excluded_contact_ids: [], reverse_selection: false },
  } });
  assert.deepEqual(calls.find(call => call.path.endsWith('/contacts')).options.filter, copy.body.contacts_selection.filter);
  assert.deepEqual(writes(calls)[1], { path: '/contact-lists/888', method: 'PUT', options: {}, body: { name: 'DAF Paris — Messieurs' } });
  assert.equal(changesData('copy_contacts_to_list', JSON.stringify(result)), true);
  assert.deepEqual(cardsForTool('copy_contacts_to_list', JSON.stringify(result)), [{ kind: 'lists', items: [{ id: 888, name: 'DAF Paris — Messieurs' }], purpose: 'created' }]);
});

test('an existing destination is verified and receives one copy without being renamed', async t => {
  const { calls, run } = fixture(t);
  const result = await run({ destination_list_id: 777 });
  assert.equal(result.list_id, 777); assert.equal(result.list_name, 'Destination');
  assert.equal(writes(calls).length, 1);
  assert.equal(writes(calls)[0].body.contact_list_id_destination, 777);
});

test('invalid or empty filters, invented fields, conflicting destinations and self-copy cannot write', async t => {
  const { calls, run } = fixture(t);
  for (const args of [
    { filter: { mode: 'and', values: [] } }, { filter: { mode: 'all', values: filter.values } },
    { filter: { mode: 'and', values: [{ field_name: 'civility', type: 'equals', value: 'Monsieur' }] } },
    { filter: { mode: 'and', values: [{ field_name: '999', type: 'equals', value: 'Monsieur' }] } },
    { filter: { mode: 'and', values: [{ field_name: '2', type: 'equals', value: {} }] } },
    { filter: { mode: 'and', values: [{ field_name: '2', type: 'invented', value: 'Monsieur' }] } },
    { destination_list_id: 69964 }, { destination_list_id: 777, new_list_name: 'Unknown' },
    { source_list_id: true }, { destination_list_id: '777/contacts' }, { new_list_name: '' },
    { arbitrary_body: {} },
  ]) assert.ok((await run(args)).error);
  assert.equal(writes(calls).length, 0);
});

test('unavailable source or destination refuses the copy', async t => {
  const { calls, run } = fixture(t, { forbiddenList: 777 });
  assert.equal((await run({ destination_list_id: 777 })).error, 'destination_list_unavailable');
  assert.equal((await run({ source_list_id: 123 })).error, 'source_list_unavailable');
  assert.equal(writes(calls).length, 0);
});

test('zero matches and failed or malformed previews cannot create any list', async t => {
  for (const preview of [{ state: true, number_of_results: 0 }, { state: false }, { state: true }, { state: true, number_of_results: true }]) {
    const { calls, run } = fixture(t, { preview });
    const result = await run({ new_list_name: 'Test' });
    assert.ok(result.error || result.status === 'no_matches');
    assert.equal(changesData('copy_contacts_to_list', JSON.stringify(result)), false);
    assert.equal(writes(calls).length, 0);
  }
});

test('an API state:false is not success, and the same mutation is never retried in this request', async t => {
  const { calls, run } = fixture(t, { copy: { state: false, state_message: 'copy_failed' } });
  const failed = await run();
  assert.equal(failed.error, 'copy_failed');
  assert.equal(changesData('copy_contacts_to_list', JSON.stringify(failed)), false);
  assert.deepEqual(cardsForTool('copy_contacts_to_list', JSON.stringify(failed)), []);
  assert.equal((await run()).error, 'copy_already_requested');
  assert.equal(writes(calls).length, 1);
});

test('a failed rename still reports the accepted copy and the actual destination name', async t => {
  const { calls, run } = fixture(t, { renameFails: true });
  const result = await run({ new_list_name: 'Requested name' });
  assert.equal(result.status, 'accepted'); assert.equal(result.list_name, 'Copie de DAF Paris');
  assert.match(result.warnings[0], /renommage/);
  assert.equal(changesData('copy_contacts_to_list', JSON.stringify(result)), true);
  assert.equal(writes(calls).filter(call => call.method === 'DELETE').length, 0);
});

test('missing or source IDs in a success response never cause source renaming or invented destination cards', async t => {
  for (const copy of [{ state: true }, { state: true, contact_list_id: 69964 }]) {
    const { calls, run } = fixture(t, { copy });
    const result = await run({ new_list_name: 'Test' });
    assert.equal(result.status, 'accepted'); assert.equal(result.list_id, null);
    assert.equal(changesData('copy_contacts_to_list', JSON.stringify(result)), true);
    assert.deepEqual(cardsForTool('copy_contacts_to_list', JSON.stringify(result)), []);
    assert.equal(writes(calls).length, 1);
  }
});

test('catalogue calls preserve the filter and cannot bypass selection validation or request deduplication', async t => {
  const { calls, run } = fixture(t);
  const args = { operation: 'copy_contacts_to_list', params: { id: 69964 }, body: {
    contact_list_id_destination: 777, contacts_selection: { contact_ids: [], filter, excluded_contact_ids: [], reverse_selection: false },
  } };
  const result = await run(args, 'run_operation');
  assert.equal(result.list_id, 777);
  assert.equal(changesData('run_operation', JSON.stringify(result), JSON.stringify(args)), true);
  assert.deepEqual(cardsForTool('run_operation', JSON.stringify(result), JSON.stringify(args)), [{ kind: 'lists', items: [{ id: 777, name: 'Destination' }], purpose: 'created' }]);
  assert.equal((await run({ destination_list_id: 777 })).error, 'copy_already_requested');
  for (const selection of [{ filter, contact_ids: [1] }, { filter, reverse_selection: true }, { filter, unexpected: true }]) {
    assert.equal((await run({ ...args, body: { contacts_selection: selection } }, 'run_operation')).error, 'invalid_contact_selection');
  }
  assert.equal(writes(calls).length, 1);
});

test('nested AND/OR filters and presence operators reach the API without changing their meaning', async t => {
  const { calls, run } = fixture(t);
  const nested = { mode: 'and', values: [filter, { mode: 'or', values: [
    { field_name: '3', type: 'does_exist' }, { field_name: '2', type: 'equals', value: 'Madame' },
  ] }] };
  const result = await run({ filter: nested });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(writes(calls)[0].body.contacts_selection.filter, result.criteria_applied.filter);
  assert.equal(result.criteria_applied.filter.values[1].values[0].value, '');
});

test('the documented array values and start/end operators are preserved without truncation', async t => {
  const { calls, run } = fixture(t);
  const extended = { mode: 'or', values: [
    { field_name: '2', type: 'equals', value: ['Monsieur', 'Madame'] },
    { field_name: '3', type: 'start_with', value: 'contact@' }, { field_name: '3', type: 'end_with', value: '.fr' },
  ] };
  assert.equal((await run({ filter: extended })).status, 'accepted');
  assert.deepEqual(writes(calls)[0].body.contacts_selection.filter, extended);
});
