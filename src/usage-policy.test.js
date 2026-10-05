import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { usageLimitsEnabled } from './usage-policy.js';

test('uncapped testing requires a future deployment expiry and expires automatically', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  for (const until of ['', 'invalid', '2026-09-29T11:59:59Z', '2026-09-29T12:00:00Z']) {
    assert.equal(usageLimitsEnabled(now, until), true);
  }
  assert.equal(usageLimitsEnabled(now, '2026-09-29T13:00:00Z'), false);
  assert.equal(usageLimitsEnabled(now + 3600_000, '2026-09-29T13:00:00Z'), true);
});

test('temporary tests preserve long prompts and output, lift cost/workload caps, and retain authentication', { timeout: 20000 }, async () => {
  const calls = [];
  const campaignReads = [];
  let budgetChecks = 0;
  let fixtureError;
  const answer = 'Rapport de test. '.repeat(3000);
  const upstream = http.createServer(async (req, res) => {
    try {
      if (req.url === '/users/me') return res.end(JSON.stringify({ state: true, user_profile: { id: 391, level: 'user' } }));
      if (req.url === '/key') {
        budgetChecks++;
        return res.end(JSON.stringify({ data: { limit: 0.1, limit_reset: 'daily', limit_remaining: 0 } }));
      }
      if (req.url === '/external-api-keys') return res.end(JSON.stringify({ external_api_keys_list: [
        { id: 1, type: 'openai', name: 'Test', api_key: 'owned-key' },
      ] }));
      if (req.url.startsWith('/statistics/programmations/')) {
        campaignReads.push(req.url);
        return res.end(JSON.stringify({ state: true, contacted: 10 }));
      }
      if (req.url === '/chat/completions') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = JSON.parse(raw);
        calls.push({ body, key: req.headers.authorization });
        assert.ok(!Object.hasOwn(body, 'max_tokens'));
        assert.ok(!Object.hasOwn(body, 'max_completion_tokens'));
        assert.ok(!body.provider?.max_price);
        assert.ok(!raw.includes('user-token') && !raw.includes('owned-key'));
        assert.notEqual(body.tool_choice?.function?.name, 'classify_magileads_request');
        const toolsDone = body.messages.some(message => message.role === 'tool');
        const audit = body.messages.at(-1).role === 'user' && body.messages.at(-1).content.startsWith('Audite toutes mes campagnes');
        const delta = audit && !toolsDone ? { tool_calls: Array.from({ length: 14 }, (_, index) => ({
          index, id: `read-${index}`, function: { name: 'get_campaign_statistics', arguments: JSON.stringify({ id: index + 1 }) },
        })) } : { content: answer };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return res.end(`data: ${JSON.stringify({ choices: [{ delta }], usage: { cost: 1 } })}\n\ndata: [DONE]\n\n`);
      }
      res.writeHead(404); res.end();
    } catch (error) { fixtureError = error; res.writeHead(500); res.end(); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], {
    env: { ...process.env, PORT: String(port), AI_TEST_UNLIMITED_UNTIL: new Date(Date.now() + 60_000).toISOString(),
      RATE_LIMIT_PER_MIN: '1', MAGILEADS_API_BASE: base, AI_API_URL: base, OPENAI_API_URL: base,
      AI_API_KEY: 'platform-key', AI_INCLUDED_API_KEY: 'daily-key',
      AI_MODEL: 'deepseek/deepseek-v4-pro', AI_MODEL_COMPLEX: 'deepseek/deepseek-v4-pro', AI_MODEL_INCLUDED: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chat = async (messages, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/ai/chat`, {
      method: 'POST', headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, ...options }),
    });
    assert.equal(response.status, 200);
    const stream = await response.text();
    if (fixtureError) throw fixtureError;
    return stream;
  };
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('server exited'); })]);
    const meta = await (await fetch(`http://127.0.0.1:${port}/ai/meta`)).json();
    assert.equal(meta.usageLimitsEnabled, false);
    assert.equal(meta.executionLimits.maxToolRounds, null);
    assert.equal(meta.executionLimits.modelCallTimeoutMs, null);
    assert.equal(meta.executionLimits.toolResultTruncationEnabled, false);
    const history = Array.from({ length: 62 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant', content: `History-${index}: ${'é'.repeat(2000)}`,
    }));
    const latest = { role: 'user', content: 'Audite toutes mes campagnes. ' + 'é'.repeat(20_000) };
    const stream = await chat([...history, latest]);
    assert.doesNotMatch(stream, /event: assistant.error/);
    const deltas = [...stream.matchAll(/^data: (\{.*\})$/gm)].map(match => JSON.parse(match[1]).choices?.[0]?.delta?.content ?? '').join('');
    assert.equal(deltas, answer);
    const first = calls.find(call => call.body.tool_choice === 'auto');
    assert.equal(first.body.messages.length, history.length + 2);
    assert.equal(first.body.messages[1].content, history[0].content);
    assert.ok(first.body.messages.at(-1).content === latest.content, 'Long UTF-8 prompt must be passed in full');
    assert.equal(first.key, 'Bearer platform-key');
    assert.equal(first.body.model, 'deepseek/deepseek-v4-pro');
    assert.match(stream, /"model":"deepseek\/deepseek-v4-pro"/);
    assert.equal(budgetChecks, 0);
    assert.equal(campaignReads.length, 14); // Previously blocked at the fourth campaign/13th tool.
    assert.doesNotMatch(first.body.messages[0].content, /au plus trois campagnes/);
    const personal = await chat([{ role: 'user', content: 'Audite ma campagne #1' }], { provider: 'openai', openai_key_id: 1 });
    assert.doesNotMatch(personal, /event: assistant.error/); // No per-minute test throttle.
    assert.ok(calls.some(call => call.key === 'Bearer owned-key'));
    const offTopic = await chat([{ role: 'user', content: 'Qui a découvert l’Amérique ?' }]);
    assert.doesNotMatch(offTopic, /event: assistant.error/);
    assert.ok(offTopic.includes(answer));
    const anonymous = await fetch(`http://127.0.0.1:${port}/ai/chat`, { method: 'POST', body: '{}' });
    assert.equal(anonymous.status, 401);
  } finally {
    child.kill();
    await new Promise(resolve => upstream.close(resolve));
  }
});
