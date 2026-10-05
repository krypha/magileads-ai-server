import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('location lookup is available in import and chat SSE with switched identity and no extraction', { timeout: 20000 }, async () => {
  let fixtureError;
  const lookups = [];
  const upstream = http.createServer(async (req, res) => {
    try {
      if (req.url === '/users/me') {
        assert.equal(req.headers['x-api-key'], 'switched-user');
        assert.equal(req.headers.authorization, undefined);
        return res.end(JSON.stringify({ user_profile: { id: 391, level: 'super_admin' } }));
      }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (req.url === '/targeting/linkedin/locations/search') {
        assert.equal(req.headers['x-api-key'], 'switched-user');
        assert.equal(req.headers.authorization, undefined);
        lookups.push(body);
        return res.end(JSON.stringify({ state: true, locations: [{ id: 104246759, name_fr: 'Île-de-France, France', name_en: 'Île-de-France, France' }] }));
      }
      assert.equal(req.url, '/chat/completions'); // No extraction, list write or other API call.
      assert.ok(body.tools.some(tool => tool.function.name === 'search_linkedin_locations'));
      const last = body.messages.at(-1);
      let delta;
      if (body.tool_choice?.function?.name === 'update_targeting') {
        delta = { tool_calls: [{ index: 0, id: 'criteria', function: { name: 'update_targeting', arguments: JSON.stringify({ source: 'linkedin', job_titles: ['CMO'], locations: ['Île-de-France'] }) } }] };
      } else if (last.role === 'tool' && last.tool_call_id === 'location') {
        const result = JSON.parse(last.content);
        assert.equal(result.locations[0].id, 104246759);
        delta = { content: 'La région Île-de-France, France est reconnue. Recherche non lancée.' };
      } else {
        delta = { tool_calls: [{ index: 0, id: 'location', function: { name: 'search_linkedin_locations', arguments: '{"name":"Île-de-France"}' } }] };
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      fixtureError = error;
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
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('server exited'); })]);
    for (const mode of ['import', 'chat']) {
      const response = await fetch(`http://127.0.0.1:${port}/ai/chat`, {
        method: 'POST', headers: { 'X-API-Key': 'switched-user', 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, messages: [{ role: 'user', content: 'Vérifie Île-de-France sans lancer.' }] }),
      });
      assert.equal(response.status, 200);
      const stream = await response.text();
      assert.match(stream, /search_linkedin_locations/);
      assert.match(stream, /reconnue/);
      assert.doesNotMatch(stream, /assistant.error|assistant.changed|assistant.card|"creates_list":true/);
    }
    assert.deepEqual(lookups, [{ name: 'Île-de-France' }, { name: 'Île-de-France' }]);
    if (fixtureError) throw fixtureError;
  } finally {
    child.kill();
    await new Promise(resolve => upstream.close(resolve));
  }
});
