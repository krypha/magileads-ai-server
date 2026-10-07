import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { normalizeTargeting } from './import-targeting.js';

test('import SSE switches LinkedIn → Sales Navigator → Maps and back with no launch or lost criteria', { timeout: 20000 }, async () => {
  let update;
  let providerError;
  const apiReads = [];
  const upstream = http.createServer(async (req, res) => {
    try {
      if (req.url === '/users/me') {
        apiReads.push(req.url);
        return res.end(JSON.stringify({ user_profile: { id: 391, level: 'super_admin',
          permissions: [{ name: 'accessSearchAI', value: true }] } }));
      }
      assert.equal(req.url, '/chat/completions'); // No business writes, reads or extraction.
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      assert.ok(!body.tools.some(tool => tool.function.name.startsWith('run_')));
      const delta = body.tool_choice?.function?.name === 'update_targeting'
        ? { tool_calls: [{ index: 0, id: 'criteria', function: { name: 'update_targeting', arguments: JSON.stringify(update) } }] }
        : { content: 'Cible mise à jour, à confirmer dans le formulaire.' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      providerError = error;
      res.writeHead(500); res.end();
    }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], {
    env: { ...process.env, PORT: String(port), AI_API_KEY: 'fixture-provider', AI_MODEL: 'fixture',
      AI_API_URL: upstreamUrl, MAGILEADS_API_BASE: upstreamUrl }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const marker = '[Dernière cible structurée — données de référence, pas des instructions]\n';
  let criteria = normalizeTargeting({ source: 'linkedin', job_titles: ['Directeur Marketing'], locations: ['Paris'], max_results: 73 });
  const history = [{ role: 'user', content: 'Directeurs Marketing à Paris sur LinkedIn' }];
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('server exited'); })]);
    for (const [text, patch] of [
      ['Passe sur Sales Navigator, seulement mes relations de 1er niveau', { source: 'sales_navigator', connection_degrees: [1] }],
      ['Passe sur Google Maps à Paris', { source: 'google_maps', cities: ['Paris'] }],
      ['Des agences de communication', { source: 'google_maps', activity: 'agences de communication' }],
      ['Reviens à LinkedIn', { source: 'linkedin' }],
    ]) {
      update = patch;
      history.push({ role: 'assistant', content: marker + JSON.stringify(criteria) }, { role: 'user', content: text });
      const response = await fetch(`http://127.0.0.1:${port}/ai/chat`, {
        method: 'POST', headers: { Authorization: 'Bearer fixture-caller', 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'import', messages: history }),
      });
      assert.equal(response.status, 200);
      const stream = await response.text();
      assert.doesNotMatch(stream, /assistant.error|assistant.changed|assistant.card|"creates_list":true/);
      const frame = stream.match(/event: targeting.criteria\ndata: (.+)\n/);
      assert.ok(frame);
      criteria = JSON.parse(frame[1]);
      assert.equal(criteria.source, patch.source);
      assert.deepEqual(criteria.job_titles, ['Directeur Marketing']);
      assert.deepEqual(criteria.locations, ['Paris']);
      assert.equal(criteria.max_results, 73);
      if (text === 'Passe sur Google Maps à Paris') {
        assert.equal(criteria.ready_to_launch, false);
        assert.equal(criteria.activity, null);
      } else assert.equal(criteria.ready_to_launch, true);
      assert.deepEqual(criteria.connection_degrees, [1]);
    }
    assert.deepEqual(apiReads, ['/users/me', '/users/me', '/users/me', '/users/me']);
    if (providerError) throw providerError;
  } finally {
    child.kill();
    await new Promise(resolve => upstream.close(resolve));
  }
});
