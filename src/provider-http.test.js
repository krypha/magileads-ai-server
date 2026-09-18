import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('HTTP keys stay account-scoped and both direct providers stream through the assistant', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'magileads-provider-http-'));
  let openaiCalls = 0;
  let anthropicCalls = 0;
  let providerError;
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/users/me') {
      const id = req.headers.authorization === 'Bearer account-one' ? 1 : 2;
      return res.end(JSON.stringify({ state: true, user_profile: { id, first_name: `User ${id}` } }));
    }
    if (req.url === '/contact-lists-paginated/page/1?options=%7B%22per_page%22%3A50%7D') {
      return res.end(JSON.stringify({ state: true, results: [{ id: 42, name: 'Fixture list' }], number_of_results: 1 }));
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    try {
      if (req.url === '/chat/completions') {
        openaiCalls++;
        assert.equal(req.headers.authorization, 'Bearer openai-account-one');
        assert.ok(!raw.includes('openai-account-one'));
        assert.equal(JSON.parse(raw).model, 'gpt-5.4-mini');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return res.end('data: {"choices":[{"delta":{"content":"OpenAI works"}}]}\n\ndata: [DONE]\n\n');
      }
      if (req.url === '/messages') {
        assert.equal(req.headers['x-api-key'], 'anthropic-account-one');
        assert.ok(!raw.includes('anthropic-account-one'));
        const body = JSON.parse(raw);
        assert.equal(body.model, 'claude-haiku-4-5-20251001');
        anthropicCalls++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (anthropicCalls === 1) {
          return res.end([
            'event: content_block_start\ndata: {"index":0,"content_block":{"type":"tool_use","id":"tool-1","name":"list_contact_lists","input":{}}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(''));
        }
        assert.equal(body.messages.at(-2).content[0].type, 'tool_use');
        assert.equal(body.messages.at(-1).content[0].type, 'tool_result');
        return res.end('event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"Claude works"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
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
      AI_API_KEY: 'openrouter-platform-key', AI_MODEL: 'fixture',
      AI_CREDENTIALS_KEY: randomBytes(32).toString('hex'),
      AI_CREDENTIALS_FILE: path.join(directory, 'keys.json'),
      OPENAI_API_URL: upstreamUrl, ANTHROPIC_API_URL: upstreamUrl,
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
    const statusBefore = await (await call('account-two', '/ai/provider-keys')).json();
    assert.deepEqual(statusBefore.configured, { openai: false, anthropic: false });
    assert.equal((await call('account-one', '/ai/provider-keys/openai', 'PUT', { api_key: 'openai-account-one' })).status, 200);
    assert.equal((await call('account-one', '/ai/provider-keys/anthropic', 'PUT', { api_key: 'anthropic-account-one' })).status, 200);
    const first = await (await call('account-one', '/ai/provider-keys')).json();
    assert.deepEqual(first.configured, { openai: true, anthropic: true });
    assert.ok(!JSON.stringify(first).includes('account-one'));
    const second = await (await call('account-two', '/ai/provider-keys')).json();
    assert.deepEqual(second.configured, { openai: false, anthropic: false });

    const message = [{ role: 'user', content: 'Mes listes' }];
    const missing = await call('account-two', '/ai/chat', 'POST', { provider: 'openai', tier: 'simple', messages: message });
    assert.equal(missing.status, 412);
    const paidAsFree = await call('account-one', '/ai/chat', 'POST', { provider: 'anthropic', tier: 'free', messages: message });
    assert.equal(paidAsFree.status, 400);

    const openai = await call('account-one', '/ai/chat', 'POST', { provider: 'openai', tier: 'simple', messages: message });
    assert.equal(openai.status, 200);
    assert.match(await openai.text(), /OpenAI works/);
    const claude = await call('account-one', '/ai/chat', 'POST', { provider: 'anthropic', tier: 'simple', messages: message });
    assert.equal(claude.status, 200);
    const stream = await claude.text();
    assert.match(stream, /event: assistant.card/);
    assert.match(stream, /Claude works/);
    assert.equal(openaiCalls, 1);
    assert.equal(anthropicCalls, 2);
    if (providerError) throw providerError;
    assert.equal((await call('account-one', '/ai/provider-keys/openai', 'DELETE')).status, 200);
    assert.equal((await (await call('account-one', '/ai/provider-keys')).json()).configured.openai, false);
  } finally {
    child.kill();
    await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
