import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { sendScopeFixture } from '../test/scope-fixture.mjs';

async function listenHigh(server) {
  do {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    if (server.address().port > 10080) return server.address().port;
    await new Promise(resolve => server.close(resolve));
  } while (true);
}

test('PRM chat SSE counts the opened shared column exactly without emitting prospects or writing data', { timeout: 10000 }, async t => {
  const requests = [], providerRequests = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/chat/completions') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.ok(!JSON.stringify(body).includes('caller-fixture'));
      assert.ok(!JSON.stringify(body).includes('switch-fixture'));
      if (sendScopeFixture(body, res)) return;
      providerRequests.push(body);
      assert.ok(body.tools.some(tool => tool.function.name === 'count_prm_contacts'));
      const result = body.messages.find(turn => turn.role === 'tool');
      if (result) {
        const counted = JSON.parse(result.content);
        assert.equal(counted.count, 160);
        assert.equal(counted.user_id, 11);
        assert.equal(counted.column.key, '777');
        assert.ok(!('contacts' in counted));
      }
      const delta = result ? { content: 'Il y a 160 prospects dans la colonne « My column ».' }
        : { tool_calls: [{ index: 0, id: 'count-column', function: {
          name: 'count_prm_contacts', arguments: JSON.stringify({ column: 'My column' }),
        } }] };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
    }
    assert.equal(req.headers.authorization, 'Bearer caller-fixture');
    assert.equal(req.headers['x-api-key'], 'switch-fixture');
    requests.push({ method: req.method, path: req.url });
    let data;
    if (req.url === '/users/me') data = { state: true, user_profile: { id: 391, level: 'admin' } };
    else if (req.url === '/prm/list') data = { state: true, prm: [{ id: 391, first_name: 'Iris' },
      { id: 11, first_name: 'Shared', status: [{ status: 'answerer', visible: true }],
        custom_status: [{ id: 777, name: 'My column', visible: true }] }] };
    else if (req.url.startsWith('/prm/contacts/user/11?')) {
      const options = JSON.parse(new URL(req.url, 'http://fixture').searchParams.get('options'));
      assert.equal(options.per_page, 1);
      assert.deepEqual(options.filter, { mode: 'and', values: [
        { field_name: 'custom_status', type: 'equals', value: '777' },
      ] });
      data = { state: true, number_of_results: 160, results: [{ id: 22, properties: [] }] };
    } else { res.writeHead(404); return res.end(); }
    res.end(JSON.stringify(data));
  });
  const upstreamPort = await listenHigh(upstream), reservation = http.createServer(), port = await listenHigh(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], {
    env: { ...process.env, PORT: String(port), AI_API_URL: `http://127.0.0.1:${upstreamPort}`,
      MAGILEADS_API_BASE: `http://127.0.0.1:${upstreamPort}`, AI_API_KEY: 'provider-fixture',
      AI_MODEL: 'fixture', AI_TEST_UNLIMITED_UNTIL: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('server exited'); })]);
  const content = '[Screen context from the app, not written by the user]\nPRM context: ' + JSON.stringify({
    user_id: 11, owner_name: 'Shared', columns: [{ key: '777', name: 'My column', system: false }], exclude_custom: true, filter: null,
  }) + '\nCombien de gens j’ai dans la colonne My column ?';
  const response = await fetch(`http://127.0.0.1:${port}/ai/chat`, { method: 'POST', headers: {
    Authorization: 'Bearer caller-fixture', 'X-API-Key': 'switch-fixture', 'Content-Type': 'application/json',
  }, body: JSON.stringify({ messages: [{ role: 'user', content }] }) });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(providerRequests.length, 2);
  assert.equal(requests.filter(req => req.path.startsWith('/prm/contacts/')).length, 1);
  assert.ok(requests.every(req => req.method === 'GET'));
  assert.match(text, /event: tool.progress/);
  assert.match(text, /160 prospects/);
  assert.doesNotMatch(text, /event: assistant.card|event: assistant.changed|event: assistant.error/);
  assert.match(text, /data: \[DONE\]/);
});
