import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { sendScopeFixture } from '../test/scope-fixture.mjs';

test('regular users get capped Flash, then free, and oversized prompts stop before upstream', { timeout: 20000 }, async () => {
  let remaining = 1;
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/users/me') {
      return res.end(JSON.stringify({ state: true, user_profile: { id: 391, level: 'user' } }));
    }
    if (req.url === '/key') {
      assert.equal(req.headers.authorization, 'Bearer included-key');
      return res.end(JSON.stringify({ data: { limit: 3, limit_reset: 'daily', limit_remaining: remaining } }));
    }
    if (req.url === '/chat/completions') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      if (sendScopeFixture(JSON.parse(raw), res)) return;
      calls.push({ key: req.headers.authorization, body: JSON.parse(raw) });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
    }
    res.writeHead(404); res.end();
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], {
    env: { ...process.env, PORT: String(port), MAGILEADS_API_BASE: upstreamUrl, AI_API_URL: upstreamUrl,
      AI_TEST_UNLIMITED_UNTIL: '',
      AI_API_KEY: 'main-key', AI_INCLUDED_API_KEY: 'included-key', AI_API_KEY_FREE: 'free-key',
      AI_MODEL: 'admin-model', AI_MODEL_FREE: 'fixture/model:free', AI_MODEL_INCLUDED: 'deepseek/deepseek-v4-flash' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chat = (content) => fetch(`http://127.0.0.1:${port}/ai/chat`, {
    method: 'POST', headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'openrouter', tier: 'complex',
      AI_TEST_UNLIMITED_UNTIL: new Date(Date.now() + 3600_000).toISOString(),
      messages: [{ role: 'user', content }] }),
  });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('server exited'); })]);
    const paid = await chat('Audit de campagne');
    assert.equal(paid.status, 200);
    assert.match(await paid.text(), /"tier":"simple"/);
    assert.equal(calls[0].body.model, 'deepseek/deepseek-v4-flash');
    assert.equal(calls[0].body.max_tokens, 2048);
    assert.equal(calls[0].key, 'Bearer included-key');

    remaining = 0;
    const free = await chat('Mes listes');
    assert.equal(free.status, 200);
    assert.match(await free.text(), /"tier":"free"/);
    assert.equal(calls[1].body.model, 'fixture/model:free');
    assert.equal(calls[1].key, 'Bearer free-key');
    assert.deepEqual(calls[1].body.provider.max_price, { prompt: 0, completion: 0, request: 0 });

    const heavy = await chat('x'.repeat(4001));
    assert.equal(heavy.status, 413);
    assert.equal((await heavy.json()).errorKey, 'shared_prompt_too_large');
    assert.equal(calls.length, 2);
  } finally {
    child.kill();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('each account has its own daily share, and a white label answers on the free model', { timeout: 20000 }, async () => {
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/users/me') {
      const id = req.headers.authorization === 'Bearer other-token' ? 392 : 391;
      return res.end(JSON.stringify({ state: true, user_profile: { id, level: 'user' } }));
    }
    if (req.url === '/key') {
      return res.end(JSON.stringify({ data: { limit: 3, limit_reset: 'daily', limit_remaining: 2 } }));
    }
    if (req.url === '/chat/completions') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      if (sendScopeFixture(JSON.parse(raw), res)) return;
      const body = JSON.parse(raw);
      calls.push({ key: req.headers.authorization, body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // What OpenRouter reports in the last chunk when asked for usage.
      const cost = body.model.endsWith(':free') ? 0 : 0.05;
      return res.end(`data: {"choices":[{"delta":{"content":"OK"}}],"usage":{"cost":${cost}}}\n\ndata: [DONE]\n\n`);
    }
    res.writeHead(404); res.end();
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], {
    env: { ...process.env, PORT: String(port), MAGILEADS_API_BASE: upstreamUrl, AI_API_URL: upstreamUrl,
      AI_TEST_UNLIMITED_UNTIL: '', REDIS_URL: '',
      AI_API_KEY: 'main-key', AI_INCLUDED_API_KEY: 'included-key', AI_API_KEY_FREE: 'free-key',
      AI_MODEL_FREE: 'fixture/model:free', AI_MODEL_INCLUDED: 'deepseek/deepseek-v4-flash',
      AI_INCLUDED_USER_DAILY_USD: '0.06', AI_INCLUDED_ORIGINS: 'https://beta.magileads.io' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chat = (token, origin) => fetch(`http://127.0.0.1:${port}/ai/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ provider: 'openrouter', messages: [{ role: 'user', content: 'Mes campagnes' }] }),
  });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('server exited'); })]);
    // 0 then 0.05 spent: both under 0.06, both paid, and the cost is asked for.
    for (const expected of [0, 1]) {
      const paid = await chat('user-token', 'https://beta.magileads.io');
      assert.match(await paid.text(), /"tier":"simple"/);
      assert.equal(calls[expected].body.model, 'deepseek/deepseek-v4-flash');
      assert.deepEqual(calls[expected].body.usage, { include: true });
    }
    // 0.10 spent: this account is on the free model until tomorrow…
    const spent = await chat('user-token', 'https://beta.magileads.io');
    const spentText = await spent.text();
    assert.match(spentText, /"tier":"free"/);
    assert.match(spentText, /"fallback_reason":"user_daily_budget"/);
    assert.equal(calls[2].body.model, 'fixture/model:free');
    // …while another account still gets the paid one.
    const other = await chat('other-token', 'https://beta.magileads.io');
    assert.match(await other.text(), /"tier":"simple"/);
    assert.equal(calls[3].body.model, 'deepseek/deepseek-v4-flash');
    // A white label's front never reaches the shared paid key.
    const whiteLabel = await chat('other-token', 'https://app.surleads.com');
    const whiteLabelText = await whiteLabel.text();
    assert.match(whiteLabelText, /"fallback_reason":"white_label"/);
    assert.equal(calls[4].body.model, 'fixture/model:free');
    assert.equal(calls[4].key, 'Bearer free-key');
  } finally {
    child.kill();
    await new Promise(resolve => upstream.close(resolve));
  }
});
