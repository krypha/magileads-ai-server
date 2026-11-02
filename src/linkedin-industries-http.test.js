import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('import SSE can search real industry labels then replace an unresolved target, without extraction', { timeout: 20000 }, async () => {
  let providerError, searches = 0;
  const upstream = http.createServer(async (req, res) => {
    try {
      if (req.url === '/users/me') return res.end(JSON.stringify({ user_profile: { id: 1, level: 'super_admin', permissions: [{ name: 'accessSearchAI', value: true }] } }));
      assert.equal(req.url, '/chat/completions'); // No business API call at all.
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      assert.ok(body.tools.some(tool => tool.function.name === 'search_linkedin_industries'));
      assert.ok(!body.tools.some(tool => tool.function.name.startsWith('run_')));
      const results = body.messages.filter(message => message.role === 'tool');
      let delta;
      if (!results.length) delta = { tool_calls: [{ index: 0, id: 'first', function: { name: 'update_targeting', arguments: JSON.stringify({ source: 'sales_navigator', job_titles: ['CEO'], sectors: ['SaaS'] }) } }] };
      else if (results.length === 1) {
        assert.equal(JSON.parse(results[0].content).ready_to_launch, false);
        delta = { tool_calls: [{ index: 0, id: 'catalog', function: { name: 'search_linkedin_industries', arguments: '{"query":"SaaS"}' } }] };
      } else if (results.length === 2) {
        searches++;
        const actual = JSON.parse(results[1].content).industries.find(item => item.id === '4');
        assert.equal(actual.name_fr, 'Développement de logiciels');
        delta = { tool_calls: [{ index: 0, id: 'resolved', function: { name: 'update_targeting', arguments: JSON.stringify({ sectors: [actual.name_fr] }) } }] };
      } else delta = { content: 'Le secteur retenu est Développement de logiciels. Confirmez la cible dans le formulaire.' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) { providerError = error; res.writeHead(500); res.end(); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const url = `http://127.0.0.1:${upstream.address().port}`;
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], {
    env: { ...process.env, PORT: String(port), AI_API_KEY: 'fixture', AI_MODEL: 'fixture', AI_API_URL: url, MAGILEADS_API_BASE: url },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('server exited'); })]);
    const response = await fetch(`http://127.0.0.1:${port}/ai/chat`, {
      method: 'POST', headers: { Authorization: 'Bearer fixture-user', 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'import', messages: [{ role: 'user', content: 'Prépare des CEO dans le SaaS sur Sales Navigator' }] }),
    });
    assert.equal(response.status, 200);
    const stream = await response.text();
    if (providerError) throw providerError;
    assert.match(stream, /event: targeting.criteria/);
    assert.match(stream, /"sectors":\["SaaS"\]/);
    assert.match(stream, /"ready_to_launch":false/);
    assert.match(stream, /"sectors":\["Développement de logiciels"\]/);
    assert.match(stream, /"ready_to_launch":true/);
    assert.match(stream, /"tool":"search_linkedin_industries"/);
    assert.doesNotMatch(stream, /assistant.error|assistant.changed|assistant.card|"creates_list":true/);
    assert.equal(searches, 1);
  } finally {
    child.kill(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
});
