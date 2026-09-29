import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { sendScopeFixture } from '../test/scope-fixture.mjs';
import { executeTool } from './tools.js';

const filter = { mode: 'and', values: [{ field_name: '7', type: 'equals', value: 'M.' }] };
const marker = `[[ACTION]]${JSON.stringify({ type: 'delete_contacts', list_id: 42, filter })}[[/ACTION]]`;

test('preview refuses field identifiers instead of silently counting the wrong field', async () => {
  const response = JSON.parse(await executeTool('preview_contact_selection', JSON.stringify({
    list_id: 42, filter: { mode: 'and', values: [{ field_name: 'civility', type: 'equals', value: 'M.' }] },
  }), { accessToken: 'fictional-fixture-only' }));
  assert.match(response.error, /ID numérique/);
  assert.equal(response.count, undefined);
});
async function listenHigh(server) {
  do {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    if (server.address().port > 10080) return server.address().port;
    await new Promise(resolve => server.close(resolve));
  } while (true);
}
async function fixture(t, { attemptDelete = false } = {}) {
  const calls = [], apiCalls = [];
  const api = http.createServer(async (req, res) => {
    if (req.url === '/chat/completions') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (sendScopeFixture(request, res)) return;
      calls.push(request);
      assert.ok(!JSON.stringify(request).includes('caller-fixture'));
      const number = request.messages.filter(message => message.role === 'tool').length;
      const names = ['get_contact_list', 'list_contact_fields', 'preview_contact_selection'];
      const args = [{ id: 42 }, {}, { list_id: 42, filter }];
      const deleting = request.messages.some(message => message.role === 'user' && /Supprime/.test(message.content));
      const malicious = attemptDelete && number === 3;
      const delta = number < 3 || malicious ? { tool_calls: [{ index: 0, id: `call-${number}`, function: {
        name: malicious ? 'delete_contacts_by_selection' : names[number],
        arguments: JSON.stringify(malicious ? { list_id: 42, filter } : args[number]),
      } }] } : { content: deleting ? `Je propose de supprimer les contacts de civilité M. de « Test list ».\n${marker}` : 'La liste comporte 12 contacts correspondant au comptage demandé.' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
    }
    apiCalls.push({ method: req.method, path: req.url });
    assert.equal(req.headers.authorization, 'Bearer caller-fixture');
    assert.equal(req.headers['x-api-key'], 'switched-fixture');
    if (req.url === '/users/me') return res.end(JSON.stringify({ state: true, user_profile: { id: 391, level: 'admin' } }));
    if (req.url === '/contact-lists/42') return res.end(JSON.stringify({ state: true, contact_list_profile: { id: 42, name: 'Test list', number_of_contacts: 30 } }));
    if (req.url === '/data-fields') return res.end(JSON.stringify({ state: true, data_fields_list: [
      { id: 7, name: 'Civilité', identifier: 'civility', possible_values: ['M.', 'Mme'] },
    ] }));
    if (req.url.startsWith('/contact-lists/42/contacts?')) return res.end(JSON.stringify({ state: true, number_of_results: 12, results: [] }));
    res.writeHead(404); res.end();
  });
  const apiPort = await listenHigh(api);
  const reservation = http.createServer(), port = await listenHigh(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], {
    env: { ...process.env, PORT: String(port), AI_API_URL: `http://127.0.0.1:${apiPort}`, MAGILEADS_API_BASE: `http://127.0.0.1:${apiPort}`,
      AI_API_KEY: 'provider-fixture', AI_MODEL: 'fixture', AI_TEST_UNLIMITED_UNTIL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('server exited'); })]);
  const chat = async input => {
    const response = await fetch(`http://127.0.0.1:${port}/ai/chat`, { method: 'POST', headers: {
      Authorization: 'Bearer caller-fixture', 'X-API-Key': 'switched-fixture', 'Content-Type': 'application/json',
    }, body: JSON.stringify({ messages: Array.isArray(input) ? input : [{ role: 'user', content: input }] }) });
    assert.equal(response.status, 200); return response.text();
  };
  return { calls, apiCalls, chat };
}

test('full assistant prepares a verified contact proposal without screen context or any API write', { timeout: 10000 }, async t => {
  const { calls, apiCalls, chat } = await fixture(t);
  const stream = await chat('Supprime les contacts dont la civilité est Monsieur dans la liste #42');
  assert.match(calls[0].messages[0].content, /ASSISTANT COMPLET ET BULLE/);
  assert.match(calls[0].messages[0].content, /aucune liste n’est ouverte implicitement/);
  assert.ok(!calls[0].tools.some(tool => /delete|remove/.test(tool.function.name)));
  assert.deepEqual(JSON.parse(calls[2].messages.at(-1).content).fields[0].possible_values, ['M.', 'Mme']);
  assert.equal(JSON.parse(calls[3].messages.at(-1).content).count, 12);
  const text = [...stream.matchAll(/^data: (\{.*\})$/gm)].map(match => JSON.parse(match[1]).choices?.[0]?.delta?.content ?? '').join('');
  assert.ok(text.endsWith(marker));
  assert.equal((text.match(/\[\[ACTION\]\]/g) ?? []).length, 1);
  assert.ok(apiCalls.every(call => call.method === 'GET'));
  assert.doesNotMatch(stream, /event: assistant.changed|event: assistant.error/);
  const ordinary = await chat('Combien de contacts ont un email dans la liste #42 ?');
  assert.doesNotMatch(ordinary, /\[\[ACTION\]\]/);
});

test('even an explicit chat confirmation and an attempted model deletion cannot write through the server', { timeout: 10000 }, async t => {
  const { calls, apiCalls, chat } = await fixture(t, { attemptDelete: true });
  const stream = await chat([
    { role: 'user', content: 'Supprime les contacts de civilité Monsieur dans la liste #42' },
    { role: 'assistant', content: marker },
    { role: 'user', content: 'Oui, je confirme la suppression.' },
  ]);
  assert.equal(JSON.parse(calls[4].messages.at(-1).content).error, 'operation_not_allowed');
  assert.ok(apiCalls.every(call => call.method === 'GET'));
  assert.doesNotMatch(stream, /event: assistant.changed/);
});
