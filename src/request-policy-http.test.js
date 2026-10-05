import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { sendScopeFixture } from '../test/scope-fixture.mjs';
import { AI_TOOLS } from './tools.js';
import { buildSystemPrompt } from './prompt.js';
import { RequestBudget } from './included-budget.js';

test('all assistant surfaces allow general questions while included cost and workload checks remain', { timeout: 20000 }, async () => {
  let scenario = 'off_topic';
  let remaining = 1;
  let modelCalls = 0;
  const apiCalls = [];
  const scopeCalls = [];
  const modelRequests = [];
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
      modelRequests.push(body);
      assert.ok(!body.tools.some(tool => tool.function.name === 'classify_magileads_request'));
      let delta = { content: 'Réponse Magileads.' };
      if (body.tool_choice?.function?.name === 'update_targeting') delta = { tool_calls: [{ index: 0,
        id: 'import-no-target', function: { name: 'update_targeting', arguments: '{"source":null}' } }] };
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
  // Permit the initial catalogue once; reject the expanded results. Keep this
  // fixture independent of the growing tool schemas (including PRM filters).
  const firstCallBudget = new RequestBudget(0.10).reserve([
    { role: 'system', content: buildSystemPrompt({ id: 391, level: 'user' }) },
    { role: 'user', content: 'Test de politique' },
  ], AI_TOOLS, 2048).amount + 0.001;
  const child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], {
    env: { ...process.env, PORT: String(port), MAGILEADS_API_BASE: base, AI_API_URL: base, OPENAI_API_URL: base,
      AI_TEST_UNLIMITED_UNTIL: '',
      AI_API_KEY: 'platform-key', AI_INCLUDED_API_KEY: 'capped-key', AI_MODEL: 'fixture',
      AI_MODEL_FREE: 'misconfigured/paid,fixture/model:free', AI_INCLUDED_MAX_REQUEST_USD: String(firstCallBudget) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chat = async (options = {}, token = 'user-token') => {
    const response = await fetch(`http://127.0.0.1:${port}/ai/chat`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Qui a découvert l’Amérique ?' }], ...options }),
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('server exited'); })]);
    assert.match(await chat(), /Réponse Magileads/);
    assert.equal(modelCalls, 1);
    assert.match(await chat({ provider: 'openai', openai_key_id: 1 }), /Réponse Magileads/);
    assert.equal(modelCalls, 2);
    assert.deepEqual(apiCalls, []);
    assert.match(await chat({}, 'admin'), /Réponse Magileads/);
    remaining = 0;
    assert.match(await chat(), /Réponse Magileads/);
    assert.equal(modelRequests.at(-1).model, 'fixture/model:free');
    assert.deepEqual(modelRequests.at(-1).provider.max_price, { prompt: 0, completion: 0, request: 0 });
    remaining = 1;
    scenario = 'broad_campaign_audit';
    assert.match(await chat(), /Réponse Magileads/);
    assert.deepEqual(apiCalls, []);
    // A personal key also bypasses the shared budget and workload checks.
    assert.match(await chat({ provider: 'openai', openai_key_id: 1 }), /Réponse Magileads/);
    scenario = 'bad_scope';
    assert.match(await chat(), /Réponse Magileads/);
    assert.equal(scopeCalls.length, 0);
    scenario = 'cost';
    const beforeCost = modelCalls;
    const expensive = await chat();
    assert.match(expensive, /"code":"request_budget_exceeded"/);
    assert.equal(modelCalls, beforeCost + 1); // Growing tool results were never sent upstream.
    assert.deepEqual(apiCalls, []);
    scenario = 'four_campaigns';
    const tooMany = await chat();
    assert.match(tooMany, /"code":"request_too_broad"/);
    assert.deepEqual(apiCalls, ['/statistics/programmations/1', '/statistics/programmations/2', '/statistics/programmations/3']);
    scenario = 'allow';
    const followup = await chat({ messages: [{ role: 'user', content: 'Audite ma campagne #1' },
      { role: 'assistant', content: 'Afficher le scénario ?' }, { role: 'user', content: 'oui' }] });
    assert.match(followup, /Réponse Magileads/);
    assert.equal(modelRequests.at(-1).messages.at(-1).content, 'oui');
    assert.equal(modelRequests.at(-1).messages[1].content, 'Audite ma campagne #1');
    for (const context of [
      '[Screen context from the app, not written by the user]\nPage: PRM.',
      '[Contexte de la page Reporting fourni par l’application]',
      '[Contexte : je suis sur la page de création de liste de prospects.]',
    ]) {
      const stream = await chat({ ...(context.includes('création de liste') ? { mode: 'import' } : {}),
        messages: [{ role: 'user', content: `${context}\nQui a découvert l’Amérique ?` }] });
      assert.match(stream, /Réponse Magileads/);
      assert.doesNotMatch(stream, /event: assistant.error/);
    }
    assert.equal(scopeCalls.length, 0);
  } finally {
    child.kill();
    await new Promise(resolve => api.close(resolve));
  }
});
