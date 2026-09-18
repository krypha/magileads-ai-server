import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('OpenAI reads the active account integration from Magileads on each chat, without local key routes', { timeout: 20000 }, async () => {
  let activeKey = 'sk-account-one-current';
  let openaiCalls = 0;
  let providerError;
  const upstream = http.createServer(async (req, res) => {
    const account = req.headers.authorization === 'Bearer account-one' ? 1 : 2;
    if (req.url === '/users/me') {
      return res.end(JSON.stringify({ state: true, user_profile: { id: account, first_name: `User ${account}` } }));
    }
    if (req.url === '/external-api-keys') {
      return res.end(JSON.stringify({ state: true, external_api_keys_list: account === 1 ? [
        { id: 11, type: 'openai', api_key: 'sk-account-one-old' },
        { id: 12, type: 'openai', api_key: activeKey },
        { id: 13, type: 'dropcontact', api_key: 'dropcontact-secret' },
      ] : [{ id: 20, type: 'dropcontact', api_key: 'other-secret' }] }));
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    try {
      if (req.url === '/chat/completions') {
        openaiCalls++;
        assert.equal(req.headers.authorization, `Bearer ${activeKey}`);
        assert.ok(!raw.includes(activeKey));
        assert.ok(!raw.includes('dropcontact-secret'));
        assert.equal(JSON.parse(raw).model, 'gpt-5.4-mini');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return res.end('data: {"choices":[{"delta":{"content":"OpenAI works"}}]}\n\ndata: [DONE]\n\n');
      }
    } catch (error) {
      providerError = error;
      res.writeHead(500); return res.end();
    }
    res.writeHead(404); res.end();
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], {
    env: {
      ...process.env, PORT: String(port), MAGILEADS_API_BASE: upstreamUrl,
      AI_API_KEY: 'openrouter-platform-key', AI_MODEL: 'fixture', OPENAI_API_URL: upstreamUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const endpoint = `http://127.0.0.1:${port}`;
  const call = (token, route, method = 'GET', body) => fetch(`${endpoint}${route}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('server exited'); })]);
    const first = await (await call('account-one', '/ai/providers')).json();
    assert.deepEqual(first.configured, { openai: true, anthropic: false });
    assert.ok(!JSON.stringify(first).includes('sk-account-one'));
    const second = await (await call('account-two', '/ai/providers')).json();
    assert.deepEqual(second.configured, { openai: false, anthropic: false });

    const message = [{ role: 'user', content: 'Mes listes' }];
    assert.equal((await call('account-two', '/ai/chat', 'POST', { provider: 'openai', tier: 'simple', messages: message })).status, 412);
    assert.equal((await call('account-one', '/ai/chat', 'POST', { provider: 'anthropic', tier: 'simple', messages: message })).status, 400);
    assert.equal((await call('account-one', '/ai/chat', 'POST', { provider: 'openai', tier: 'free', messages: message })).status, 400);
    assert.equal((await call('account-one', '/ai/provider-keys/openai', 'PUT', { api_key: 'bad-key' })).status, 404);
    assert.equal((await call('account-one', '/ai/provider-keys/openai', 'DELETE')).status, 404);

    const chat = await call('account-one', '/ai/chat', 'POST', { provider: 'openai', tier: 'simple', messages: message });
    assert.equal(chat.status, 200);
    assert.match(await chat.text(), /OpenAI works/);
    activeKey = 'sk-account-one-rotated';
    const rotated = await call('account-one', '/ai/chat', 'POST', { provider: 'openai', tier: 'simple', messages: message });
    assert.equal(rotated.status, 200);
    assert.match(await rotated.text(), /OpenAI works/);
    assert.equal(openaiCalls, 2);
    if (providerError) throw providerError;
  } finally {
    child.kill();
    await new Promise(resolve => upstream.close(resolve));
  }
});
