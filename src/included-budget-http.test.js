import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

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
      AI_API_KEY: 'main-key', AI_INCLUDED_API_KEY: 'included-key', AI_API_KEY_FREE: 'free-key',
      AI_MODEL: 'admin-model', AI_MODEL_FREE: 'free-model', AI_MODEL_INCLUDED: 'deepseek/deepseek-v4-flash' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chat = (content) => fetch(`http://127.0.0.1:${port}/ai/chat`, {
    method: 'POST', headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'openrouter', tier: 'complex', messages: [{ role: 'user', content }] }),
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
    const free = await chat('Autre question');
    assert.equal(free.status, 200);
    assert.match(await free.text(), /"tier":"free"/);
    assert.equal(calls[1].body.model, 'free-model');
    assert.equal(calls[1].key, 'Bearer free-key');

    const heavy = await chat('x'.repeat(4001));
    assert.equal(heavy.status, 413);
    assert.equal((await heavy.json()).errorKey, 'shared_prompt_too_large');
    assert.equal(calls.length, 2);
  } finally {
    child.kill();
    await new Promise(resolve => upstream.close(resolve));
  }
});
