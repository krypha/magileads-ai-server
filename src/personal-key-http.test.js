import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { sendScopeFixture } from '../test/scope-fixture.mjs';

test('a personal key can answer off-topic requests with full history and more than six tool rounds', { timeout: 20000 }, async () => {
  const personalRequests = [];
  let sharedScopeCalls = 0;
  let providerError;
  const upstream = http.createServer(async (req, res) => {
    try {
      if (req.url === '/users/me') return res.end(JSON.stringify({ user_profile: { id: 391, level: 'user' } }));
      if (req.url === '/external-api-keys') return res.end(JSON.stringify({ external_api_keys_list: [
        { id: 1, type: 'openai', name: 'Personal', api_key: 'personal-provider-key' },
      ] }));
      if (req.url === '/key') return res.end(JSON.stringify({ data: { limit: 3, limit_reset: 'daily', limit_remaining: 2 } }));
      if (req.url === '/chat/completions') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        if (req.headers.authorization === 'Bearer platform-key') {
          sharedScopeCalls++;
          return sendScopeFixture(body, res, 'off_topic');
        }
        assert.equal(req.headers.authorization, 'Bearer personal-provider-key');
        assert.ok(!raw.includes('personal-provider-key'));
        assert.equal(body.reasoning_effort, 'none');
        assert.ok(!Object.hasOwn(body, 'max_tokens'));
        assert.ok(!Object.hasOwn(body, 'max_completion_tokens'));
        assert.notEqual(body.tool_choice?.function?.name, 'classify_magileads_request');
        personalRequests.push(body);
        const completed = body.messages.filter(message => message.role === 'tool').length;
        const largePayload = body.messages.at(-1)?.content?.startsWith('Large payload: ');
        const delta = largePayload
          ? { content: 'Grand message reçu.' }
          : completed < 7
          ? { tool_calls: [{ index: 0, id: `overview-${completed}`, function: { name: 'get_account_overview', arguments: '{}' } }] }
          : { content: 'Réponse libre après sept lectures.' };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
      }
      res.writeHead(404); res.end();
    } catch (error) { providerError = error; res.writeHead(500); res.end(); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], {
    env: { ...process.env, PORT: String(port), MAGILEADS_API_BASE: base, OPENAI_API_URL: base, AI_API_URL: base,
      AI_TEST_UNLIMITED_UNTIL: '', RATE_LIMIT_PER_MIN: '1', AI_API_KEY: 'platform-key', AI_INCLUDED_API_KEY: 'platform-key',
      AI_MODEL: 'fixture/model', AI_MODEL_INCLUDED: 'fixture/model' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chat = async (messages, options = {}) => fetch(`http://127.0.0.1:${port}/ai/chat`, {
    method: 'POST', headers: { Authorization: 'Bearer account-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, ...options }),
  });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('server exited'); })]);
    const history = Array.from({ length: 62 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant', content: `History-${index}: ${'é'.repeat(2000)}`,
    }));
    const latest = { role: 'user', content: 'Qui a découvert l’Amérique ? ' + 'é'.repeat(20_000) };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await chat([...history, latest], { provider: 'openai', openai_key_id: 1 });
      assert.equal(response.status, 200);
      const stream = await response.text();
      assert.match(stream, /Réponse libre après sept lectures/);
      assert.doesNotMatch(stream, /event: assistant.error/);
      if (providerError) throw providerError;
    }
    const largeMessage = 'Large payload: ' + 'x'.repeat(1_100_000);
    const large = await chat([{ role: 'user', content: largeMessage }], { provider: 'openai', openai_key_id: 1 });
    assert.equal(large.status, 200);
    assert.match(await large.text(), /Grand message reçu/);
    assert.equal(personalRequests.length, 17);
    assert.equal(personalRequests[0].messages.length, history.length + 2);
    assert.equal(personalRequests[0].messages[1].content, history[0].content);
    assert.equal(personalRequests[0].messages.at(-1).content, latest.content);
    assert.equal(personalRequests.at(-1).messages.at(-1).content, largeMessage);
    assert.match(personalRequests[0].messages[0].content, /réponds à toute demande/);
    assert.doesNotMatch(personalRequests[0].messages[0].content, /Refuse brièvement toute question indépendante/);
    assert.equal(sharedScopeCalls, 0);

    const shared = await chat([{ role: 'user', content: 'Qui a découvert l’Amérique ?' }]);
    assert.equal(shared.status, 200);
    assert.match(await shared.text(), /"code":"off_topic"/);
    assert.equal(sharedScopeCalls, 1);
    const missingKey = await chat([latest], { provider: 'openai', openai_key_id: 99 });
    assert.equal(missingKey.status, 412);
  } finally {
    child.kill();
    await new Promise(resolve => upstream.close(resolve));
  }
});
