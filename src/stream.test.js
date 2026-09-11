import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('real HTTP chat streams API-derived cards and never forwards credentials to the model', { timeout: 20000 }, async () => {
  let modelCalls = 0;
  let providerError;
  const api = http.createServer(async (req, res) => {
    if (req.url === '/users/me') return res.end(JSON.stringify({ state: true, user_profile: { id: 1, first_name: 'Test' } }));
    if (req.url === '/contact-lists-paginated/page/1?options=%7B%22per_page%22%3A50%7D') {
      assert.equal(req.headers.authorization, 'Bearer caller-test');
      return res.end(JSON.stringify({ state: true, results: [{ id: 42, name: 'Fixture list', number_of_contacts: 10 }], number_of_results: 1 }));
    }
    if (req.url === '/chat/completions') {
      let body = ''; for await (const chunk of req) body += chunk;
      try {
        assert.ok(!body.includes('caller-test'));
        const request = JSON.parse(body);
        assert.ok(!request.tools.some(tool => tool.function.name === 'delete_contacts_by_selection'));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const delta = modelCalls++ === 0
          ? { tool_calls: [{ index: 0, id: 'call1', function: { name: 'list_contact_lists', arguments: '{}' } }] }
          : { content: 'Choisissez la liste #42.' };
        res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
      } catch (error) { providerError = error; res.writeHead(500); res.end(); }
      return;
    }
    res.writeHead(404); res.end();
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const apiUrl = `http://127.0.0.1:${api.address().port}`;
  // Reserve an available port for the child server.
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], { env: { ...process.env, PORT: String(port), AI_API_KEY: 'provider-test', AI_MODEL: 'fixture', AI_API_URL: apiUrl, MAGILEADS_API_BASE: apiUrl }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('server exited'); })]);
    const response = await fetch(`http://127.0.0.1:${port}/ai/chat`, { method: 'POST', headers: { Authorization: 'Bearer caller-test', 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Mes listes' }] }) });
    const stream = await response.text();
    if (providerError) throw providerError;
    assert.equal(response.status, 200);
    assert.match(stream, /event: assistant.card/);
    assert.match(stream, /"kind":"lists"/);
    assert.match(stream, /"id":42/);
    assert.match(stream, /Choisissez la liste #42/);
    assert.match(stream, /\[DONE\]/);
    assert.equal(modelCalls, 2);
  } finally {
    child.kill();
    await new Promise(resolve => api.close(resolve));
  }
});
