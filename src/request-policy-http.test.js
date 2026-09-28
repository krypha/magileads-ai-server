import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { sendScopeFixture } from '../test/scope-fixture.mjs';

test('scope and cost gates stop HTTP tool execution across paid, free and personal-key routes', { timeout: 20000 }, async () => {
  let scenario = 'off_topic';
  let remaining = 1;
  let modelCalls = 0;
  const apiCalls = [];
  const scopeCalls = [];
  const api = http.createServer(async (req, res) => {
    if (req.url === '/users/me') return res.end(JSON.stringify({ user_profile: {
      id: 391, level: req.headers.authorization === 'Bearer admin' ? 'super_admin' : 'user',
    } }));
    if (req.url === '/key') return res.end(JSON.stringify({ data: { limit: 3, limit_reset: 'daily', limit_remaining: remaining } }));
    if (req.url === '/external-api-keys') return res.end(JSON.stringify({ external_api_keys_list: [
      { id: 1, type: 'openai', name: 'Test', api_key: 'owned-test-key' },
    ] }));
    if (req.url === '/chat/completions') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      assert.ok(!raw.includes('user-token') && !raw.includes('owned-test-key'));
      const body = JSON.parse(raw);
      if (body.tool_choice?.function?.name === 'classify_magileads_request') {
        scopeCalls.push(body);
        assert.equal(body.tools.length, 1);
        if (scenario === 'bad_scope') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          return res.end('data: {"choices":[{"delta":{"content":"allow"}}]}\n\ndata: [DONE]\n\n');
        }
        return sendScopeFixture(body, res, ['off_topic', 'broad_campaign_audit'].includes(scenario) ? scenario : 'allow');
      }
      modelCalls++;
      let delta = { content: 'Réponse Magileads.' };
      if (scenario === 'cost') delta = { tool_calls: Array.from({ length: 4 }, (_, index) => ({
        index, id: `catalog-${index}`, function: { name: 'discover_operations', arguments: '{}' },
      })) };
      if (scenario === 'four_campaigns') delta = { tool_calls: Array.from({ length: 4 }, (_, index) => ({
        index, id: `audit-${index}`, function: { name: 'get_campaign_statistics', arguments: JSON.stringify({ id: index + 1 }) },
      })) };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.end(`data: ${JSON.stringify({ choices: [{ delta }], usage: { cost: 0.0002 } })}\n\ndata: [DONE]\n\n`);
    }
    apiCalls.push(req.url);
    res.end(JSON.stringify({ state: true, contacts_opened: 10 }));
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const base = `http://127.0.0.1:${api.address().port}`;
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], {
    env: { ...process.env, PORT: String(port), MAGILEADS_API_BASE: base, AI_API_URL: base, OPENAI_API_URL: base,
      AI_API_KEY: 'platform-key', AI_INCLUDED_API_KEY: 'capped-key', AI_MODEL: 'fixture',
      AI_MODEL_FREE: 'misconfigured/paid,fixture/model:free', AI_INCLUDED_MAX_REQUEST_USD: '0.015' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chat = async (options = {}, token = 'user-token') => {
    const response = await fetch(`http://127.0.0.1:${port}/ai/chat`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Test de politique' }], ...options }),
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('server exited'); })]);
    for (const options of [{}, { provider: 'openai', openai_key_id: 1 }]) {
      assert.match(await chat(options), /"code":"off_topic"/);
      assert.equal(modelCalls, 0);
      assert.deepEqual(apiCalls, []);
    }
    assert.match(await chat({}, 'admin'), /"code":"off_topic"/);
    remaining = 0;
    assert.match(await chat(), /"code":"off_topic"/);
    assert.equal(scopeCalls.at(-1).model, 'fixture/model:free');
    assert.deepEqual(scopeCalls.at(-1).provider.max_price, { prompt: 0, completion: 0, request: 0 });
    remaining = 1;
    scenario = 'broad_campaign_audit';
    assert.match(await chat(), /"code":"request_too_broad"/);
    assert.equal(modelCalls, 0);
    assert.deepEqual(apiCalls, []);
    // A personal key lifts the shared budget/breadth cap, never the scope gate.
    assert.match(await chat({ provider: 'openai', openai_key_id: 1 }), /Réponse Magileads/);
    scenario = 'bad_scope';
    assert.match(await chat(), /"code":"scope_check_unavailable"/);
    assert.equal(modelCalls, 1);
    scenario = 'cost';
    const expensive = await chat();
    assert.match(expensive, /"code":"request_budget_exceeded"/);
    assert.equal(modelCalls, 2); // Growing tool results were never sent upstream.
    assert.deepEqual(apiCalls, []);
    scenario = 'four_campaigns';
    const tooMany = await chat();
    assert.match(tooMany, /"code":"request_too_broad"/);
    assert.deepEqual(apiCalls, ['/statistics/programmations/1', '/statistics/programmations/2', '/statistics/programmations/3']);
    scenario = 'allow';
    const followup = await chat({ messages: [{ role: 'user', content: 'Audite ma campagne #1' },
      { role: 'assistant', content: 'Afficher le scénario ?' }, { role: 'user', content: 'oui' }] });
    assert.match(followup, /Réponse Magileads/);
    const latest = JSON.parse(scopeCalls.at(-1).messages.at(-1).content);
    assert.equal(latest.latest_request, 'oui');
    assert.equal(latest.previous_turns[0].content, 'Audite ma campagne #1');
  } finally {
    child.kill();
    await new Promise(resolve => api.close(resolve));
  }
});
