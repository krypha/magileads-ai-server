import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { sendScopeFixture } from '../test/scope-fixture.mjs';

test('personal Claude, Gemini, DeepSeek and OpenRouter keys work for a regular user', { timeout: 20000 }, async () => {
  const specs = [
    { provider: 'anthropic', type: 'claude', id: 1, model: 'claude-sonnet-5' },
    { provider: 'gemini', type: 'gemini', id: 2, model: 'gemini-3-flash' },
    { provider: 'deepseek', type: 'deepseek', id: 3, model: 'deepseek-v4-pro' },
    { provider: 'openrouter', type: 'openrouter', id: 4, model: 'deepseek/deepseek-v4-pro' },
  ];
  const seen = [];
  let fixtureError;
  const upstream = http.createServer(async (req, res) => {
    try {
      if (req.url === '/users/me') return res.end(JSON.stringify({ user_profile: { id: 55, level: 'user' } }));
      if (req.url === '/external-api-keys') return res.end(JSON.stringify({ external_api_keys_list:
        specs.map(spec => ({ id: spec.id, type: spec.type, name: spec.provider, api_key: `private-${spec.provider}` })) }));
      const spec = specs.find(item => req.headers['x-api-key'] === `private-${item.provider}` ||
        req.headers['x-goog-api-key'] === `private-${item.provider}` ||
        req.headers.authorization === `Bearer private-${item.provider}`);
      if (!spec) throw new Error('provider key missing or wrong');
      if (req.url.startsWith('/models')) {
        const catalog = spec.provider === 'gemini'
          ? { models: [{ name: `models/${spec.model}`, supportedGenerationMethods: ['generateContent'] }] }
          : { data: [{ id: spec.model, supported_parameters: ['tools'],
            ...(spec.provider === 'anthropic' ? { max_tokens: 128000 } : {}) }] };
        return res.end(JSON.stringify(catalog));
      }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(body.model, spec.model);
      if (spec.provider === 'anthropic') {
        assert.equal(req.url, '/messages');
        assert.equal(body.max_tokens, 128000);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (body.tools.length === 1 && body.tools[0].name === 'classify_magileads_request') {
          return res.end([
            { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'scope', name: 'classify_magileads_request' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"decision":"allow"}' } },
          ].map(item => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join(''));
        }
        seen.push(spec.provider);
        return res.end('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude works"}}\n\n');
      }
      assert.equal(req.url, spec.provider === 'gemini' ? '/openai/chat/completions' : '/chat/completions');
      if (sendScopeFixture(body, res)) return;
      seen.push(spec.provider);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: {"choices":[{"delta":{"content":"${spec.provider} works"}}]}\n\ndata: [DONE]\n\n`);
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
    env: { ...process.env, PORT: String(port), MAGILEADS_API_BASE: upstreamUrl,
      OPENAI_API_URL: upstreamUrl, ANTHROPIC_API_URL: upstreamUrl, GEMINI_API_URL: upstreamUrl,
      DEEPSEEK_API_URL: upstreamUrl, AI_API_URL: upstreamUrl, AI_API_KEY: 'shared-key', AI_MODEL: 'shared-model' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('server exited'); })]);
    const call = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer account', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const status = await (await call('/ai/providers')).json();
    assert.deepEqual(status.keys.anthropic, [{ id: 1, name: 'anthropic' }]);
    assert.ok(!JSON.stringify(status).includes('private-'));
    const withoutModel = await call('/ai/chat', { provider: 'anthropic', provider_key_id: 1,
      tier: 'simple', messages: [{ role: 'user', content: 'Mes listes' }] });
    assert.equal(withoutModel.status, 409);
    assert.equal((await withoutModel.json()).errorKey, 'model_selection_required');
    for (const spec of specs) {
      const catalog = await (await call(`/ai/models?provider=${spec.provider}&key_id=${spec.id}`)).json();
      assert.deepEqual(catalog.models.map(item => item.id), [spec.model]);
      const chat = await call('/ai/chat', { provider: spec.provider, provider_key_id: spec.id,
        model: spec.model, tier: 'simple', messages: [{ role: 'user', content: 'Mes listes' }] });
      assert.equal(chat.status, 200, spec.provider);
      assert.match(await chat.text(), /works/, spec.provider);
    }
    assert.deepEqual(seen, specs.map(spec => spec.provider));
    if (fixtureError) throw fixtureError;
  } finally {
    child.kill(); await new Promise(resolve => upstream.close(resolve));
  }
});
