import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('a model that fails mid-stream before any output hands over to the next one', { timeout: 20000 }, async () => {
  const models = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/users/me') return res.end(JSON.stringify({ state: true, user_profile: { id: 391, level: 'user' } }));
    // The key's cap is spent: the included AI is on the free models.
    if (req.url === '/key') return res.end(JSON.stringify({ data: { limit: 3, limit_reset: 'daily', limit_remaining: 0 } }));
    if (req.url === '/chat/completions') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const { model } = JSON.parse(raw);
      models.push(model);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // What OpenRouter streams when Nvidia's free endpoint is overloaded.
      if (model === 'first/overloaded:free') {
        return res.end(`data: ${JSON.stringify({ choices: [], error: { code: 503, message: 'Upstream error from Nvidia: Service temporarily overloaded' } })}\n\ndata: [DONE]\n\n`);
      }
      return res.end('data: {"choices":[{"delta":{"content":"Réponse du second modèle."}}]}\n\ndata: [DONE]\n\n');
    }
    res.writeHead(404); res.end();
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], {
    env: { ...process.env, PORT: String(port), MAGILEADS_API_BASE: base, AI_API_URL: base,
      AI_TEST_UNLIMITED_UNTIL: '', REDIS_URL: '', AI_API_KEY: 'main-key', AI_INCLUDED_API_KEY: 'included-key',
      AI_MODEL_FREE: 'first/overloaded:free,second/model:free' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('server exited'); })]);
    const response = await fetch(`http://127.0.0.1:${port}/ai/chat`, {
      method: 'POST', headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Bonjour' }] }),
    });
    const stream = await response.text();
    assert.deepEqual(models, ['first/overloaded:free', 'second/model:free']);
    assert.match(stream, /Réponse du second modèle/);
    assert.doesNotMatch(stream, /event: assistant\.error/);
    // The model announced is the one that answered.
    assert.match(stream, /"model":"second\/model:free"/);
  } finally {
    child.kill();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('the text of two rounds is kept apart by a paragraph break', { timeout: 20000 }, async () => {
  let round = 0;
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/users/me') return res.end(JSON.stringify({ state: true, user_profile: { id: 391, level: 'user' } }));
    if (req.url === '/key') return res.end(JSON.stringify({ data: { limit: 3, limit_reset: 'daily', limit_remaining: 0 } }));
    if (req.url.startsWith('/linkedin')) return res.end(JSON.stringify({ state: true, results: [] }));
    if (req.url === '/chat/completions') {
      for await (const _ of req) { /* drain */ }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // Round one says what it does and calls a tool; round two answers.
      const delta = round++ === 0
        ? { content: 'Je vérifie vos expéditeurs.', tool_calls: [{ index: 0, id: 'a', function: { name: 'list_linkedin_accounts', arguments: '{}' } }] }
        : { content: 'Oui, tout est valide.' };
      return res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
    }
    res.end(JSON.stringify({ state: true }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], {
    env: { ...process.env, PORT: String(port), MAGILEADS_API_BASE: base, AI_API_URL: base,
      AI_TEST_UNLIMITED_UNTIL: '', REDIS_URL: '', AI_API_KEY: 'main-key', AI_MODEL_FREE: 'fixture/model:free' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('server exited'); })]);
    const stream = await (await fetch(`http://127.0.0.1:${port}/ai/chat`, {
      method: 'POST', headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Mes expéditeurs ?' }] }),
    })).text();
    const text = [...stream.matchAll(/^data: (\{.*\})$/gm)].map(m => JSON.parse(m[1]).choices?.[0]?.delta?.content ?? '').join('');
    assert.equal(text, 'Je vérifie vos expéditeurs.\n\nOui, tout est valide.');
  } finally {
    child.kill();
    await new Promise(resolve => upstream.close(resolve));
  }
});
