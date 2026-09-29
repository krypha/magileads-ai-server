import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { sendScopeFixture } from '../test/scope-fixture.mjs';

const filter = { mode: 'and', values: [{ field_name: '2', type: 'equals', value: 'Monsieur' }] };
async function listenHigh(server) {
  do {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    if (server.address().port > 10080) return server.address().port;
    await new Promise(resolve => server.close(resolve));
  } while (true);
}
async function fixture(t, { catalog = false, importMode = false } = {}) {
  const requests = [], providerRequests = [];
  const toolName = catalog ? 'run_operation' : 'copy_contacts_to_list';
  const args = catalog ? { operation: 'copy_contacts_to_list', params: { id: 69964 }, body: {
    contact_list_id_destination: 777, contacts_selection: { contact_ids: [], filter, excluded_contact_ids: [], reverse_selection: false },
  } } : { source_list_id: 69964, filter, new_list_name: 'Messieurs Paris' };
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/chat/completions') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.ok(!JSON.stringify(body).includes('caller-fixture'));
      assert.ok(!JSON.stringify(body).includes('switch-fixture'));
      if (sendScopeFixture(body, res)) return;
      providerRequests.push(body);
      const completed = body.messages.filter(turn => turn.role === 'tool').length;
      const call = importMode && completed === 0 ? { name: 'update_targeting', arguments: JSON.stringify({ source: 'google_maps', activity: 'dentistes', cities: ['Paris'] }) }
        : { name: toolName, arguments: JSON.stringify(args) };
      const delta = completed < 2 ? { tool_calls: [{ index: 0, id: `call-${completed}`, function: call }] }
        : { content: importMode ? 'Cette copie n’est pas un lancement de ciblage.' : 'La copie est lancée en arrière-plan.' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
    }
    assert.equal(req.headers.authorization, 'Bearer caller-fixture');
    assert.equal(req.headers['x-api-key'], 'switch-fixture');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    requests.push({ method: req.method, path: req.url, body });
    let data;
    if (req.url === '/users/me') data = { state: true, user_profile: { id: 391, level: 'admin' } };
    else if (req.url === '/data-fields') data = { state: true, data_fields_list: [{ id: 2, name: 'Civilité', identifier: 'civility', possible_values: ['Monsieur', 'Madame'] }] };
    else if (req.url === '/contact-lists/69964') data = { state: true, contact_list_profile: { id: 69964, name: 'DAF Paris', number_of_contacts: 36 } };
    else if (req.url === '/contact-lists/777') data = { state: true, contact_list_profile: { id: 777, name: 'Destination', number_of_contacts: 20 } };
    else if (req.url.startsWith('/contact-lists/69964/contacts?')) {
      assert.deepEqual(JSON.parse(new URL(req.url, 'http://fixture').searchParams.get('options')).filter, filter);
      data = { state: true, number_of_results: 16, results: [] };
    } else if (req.url === '/contact-lists/69964/copy') data = { state: true, contact_list_id: catalog ? 777 : 888 };
    else if (req.url === '/contact-lists/888' && req.method === 'PUT') data = { state: true };
    else { res.writeHead(404); return res.end(); }
    res.end(JSON.stringify(data));
  });
  const upstreamPort = await listenHigh(upstream), reservation = http.createServer(), port = await listenHigh(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], {
    env: { ...process.env, PORT: String(port), AI_API_URL: `http://127.0.0.1:${upstreamPort}`, MAGILEADS_API_BASE: `http://127.0.0.1:${upstreamPort}`,
      AI_API_KEY: 'provider-fixture', AI_MODEL: 'fixture', AI_TEST_UNLIMITED_UNTIL: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('server exited'); })]);
  const chat = async body => {
    const response = await fetch(`http://127.0.0.1:${port}/ai/chat`, { method: 'POST', headers: {
      Authorization: 'Bearer caller-fixture', 'X-API-Key': 'switch-fixture', 'Content-Type': 'application/json',
    }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return response.text();
  };
  return { requests, providerRequests, chat };
}

for (const catalog of [false, true]) test(`HTTP ${catalog ? 'catalogue' : 'dedicated'} copy emits a hidden creation receipt and changed event once, even if the model repeats the copy`, { timeout: 10000 }, async t => {
  const { requests, chat } = await fixture(t, { catalog });
  const text = await chat({ messages: [{ role: 'user', content: 'Copie les messieurs de DAF Paris vers la destination choisie.' }] });
  assert.equal(requests.filter(req => req.method === 'POST' && req.path.endsWith('/copy')).length, 1);
  assert.deepEqual(requests.find(req => req.path.endsWith('/copy')).body.contacts_selection.filter, filter);
  assert.equal((text.match(/event: assistant.changed/g) ?? []).length, 1);
  assert.equal((text.match(/event: assistant.card/g) ?? []).length, 1);
  assert.match(text, /"creates_list":true/);
  assert.ok(text.includes(JSON.stringify({ kind: 'lists', items: [{ id: catalog ? 777 : 888, name: catalog ? 'Destination' : 'Messieurs Paris' }], purpose: 'created' })));
  assert.ok(requests.every(req => req.method !== 'DELETE'));
  assert.doesNotMatch(text, /\[\[ACTION\]\]|event: assistant.error/);
  assert.match(text, /data: \[DONE\]/);
});

test('an import approval never authorizes copying an existing segment as a replacement for its reviewed source extraction', { timeout: 10000 }, async t => {
  const { requests, providerRequests, chat } = await fixture(t, { importMode: true });
  for (const approval of [undefined, { list_name: 'Import Paris' }]) {
    await chat({ mode: 'import', ...(approval ? { import_approval: approval } : {}), messages: [
      { role: 'user', content: 'Trouve des dentistes à Paris.' }, { role: 'assistant', content: 'Cible proposée.' }, { role: 'user', content: 'La cible me convient.' },
    ] });
  }
  assert.ok(providerRequests.every(body => !body.tools.some(tool => tool.function.name === 'copy_contacts_to_list')));
  assert.ok(providerRequests.some(body => body.messages.some(message => message.role === 'tool' && /validation_explicitement_requise|outil_indisponible_pour_ce_mode|cible_incomplete/.test(message.content))));
  assert.ok(requests.every(req => req.method === 'GET'));
});
