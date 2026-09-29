import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { sendScopeFixture } from '../test/scope-fixture.mjs';

async function fixture(t, { unlimited = true, rounds = 10, slowAnswer = false, ignoreFinal = false } = {}) {
  const calls = [];
  const reads = [];
  let upstreamCancelled = false;
  const api = http.createServer(async (req, res) => {
    if (req.url === '/users/me') return res.end(JSON.stringify({ state: true,
      user_profile: { id: 391, level: unlimited ? 'user' : 'admin' } }));
    if (req.url.startsWith('/contact-lists/72120/contacts?')) {
      const options = JSON.parse(new URL(req.url, 'http://fixture').searchParams.get('options'));
      reads.push(options);
      return res.end(JSON.stringify({ state: true, number_of_results: 467, results: [] }));
    }
    if (req.url === '/chat/completions') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (sendScopeFixture(body, res)) return;
      calls.push(body);
      const completed = body.messages.filter(message => message.role === 'tool').length;
      const final = body.tool_choice === 'none';
      const needsTool = (completed < rounds && !final) || (final && ignoreFinal);
      const delta = needsTool ? { content: 'Je poursuis les comptages.\n', tool_calls: [{
        index: 0, id: `count-${completed}`, function: { name: 'preview_contact_selection', arguments: JSON.stringify({
          list_id: 72120, filter: { mode: 'and', values: [{ field_name: '71', type: 'equals', value: `Métier ${completed}` }] },
        }) },
      }] } : { content: final ? 'Synthèse des données réellement obtenues ; certains croisements restent inconnus.'
        : 'Matrice terminée après 10 comptages.' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      const answer = () => res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: needsTool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
      if (slowAnswer && !needsTool) {
        // The child compresses its former two-minute timer to 250 ms. This
        // response waits longer, without spending two minutes on the test.
        const timer = setTimeout(answer, 800);
        res.on('close', () => { if (!res.writableEnded) upstreamCancelled = true; clearTimeout(timer); });
      } else answer();
      return;
    }
    res.writeHead(404); res.end();
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const apiUrl = `http://127.0.0.1:${api.address().port}`;
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const bootstrap = `
    const nativeTimeout = globalThis.setTimeout;
    const nativeInterval = globalThis.setInterval;
    globalThis.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, ms === 120_000 ? 250 : ms, ...args);
    globalThis.setInterval = (fn, ms, ...args) => nativeInterval(fn, ms === 15_000 ? 20 : ms, ...args);
    await import(${JSON.stringify(new URL('./server.js', import.meta.url).href)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', bootstrap], {
    env: { ...process.env, PORT: String(port), MAGILEADS_API_BASE: apiUrl, AI_API_URL: apiUrl,
      AI_API_KEY: 'fixture-key', AI_MODEL: 'fixture', AI_MODEL_INCLUDED: 'fixture',
      AI_TEST_UNLIMITED_UNTIL: unlimited ? new Date(Date.now() + 60_000).toISOString() : '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill();
    api.closeAllConnections();
    await new Promise(resolve => api.close(resolve));
  });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('server exited'); })]);
  const url = `http://127.0.0.1:${port}`;
  const chat = (signal) => fetch(`${url}/ai/chat`, {
    method: 'POST', signal, headers: { Authorization: 'Bearer caller', 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Construis une matrice des métiers de la liste #72120.' }] }),
  });
  return { url, chat, calls, reads, cancelled: () => upstreamCancelled };
}

test('testing mode completes more than six tool rounds and a slow model answer, with heartbeats', { timeout: 10000 }, async t => {
  const { chat, calls, reads } = await fixture(t, { slowAnswer: true });
  const response = await chat();
  const stream = await response.text();
  assert.equal(response.status, 200);
  assert.equal(reads.length, 10);
  assert.equal(calls.length, 11);
  assert.match(stream, /Matrice terminée après 10 comptages/);
  assert.match(stream, /: keep-alive/);
  assert.doesNotMatch(stream, /event: assistant.error/);
  assert.equal((stream.match(/data: \[DONE\]/g) ?? []).length, 1);
});

test('normal mode requests a final synthesis instead of silently closing after six rounds', { timeout: 10000 }, async t => {
  const { chat, calls, reads } = await fixture(t, { unlimited: false });
  const stream = await (await chat()).text();
  assert.equal(reads.length, 6);
  assert.equal(calls.length, 7);
  assert.equal(calls.at(-1).tool_choice, 'none');
  assert.match(stream, /Synthèse des données réellement obtenues/);
  assert.doesNotMatch(stream, /event: assistant.error/);
});

test('a model cannot execute more tools when the server requires a final synthesis', { timeout: 10000 }, async t => {
  const { chat, reads } = await fixture(t, { unlimited: false, ignoreFinal: true });
  const stream = await (await chat()).text();
  assert.equal(reads.length, 6);
  assert.match(stream, /event: assistant.error/);
});

test('normal-mode provider deadline still reports an error instead of a successful partial result', { timeout: 10000 }, async t => {
  const { chat } = await fixture(t, { unlimited: false, rounds: 0, slowAnswer: true });
  const stream = await (await chat()).text();
  assert.match(stream, /"code":"stream_failed"/);
  assert.doesNotMatch(stream, /data: \[DONE\]/);
});

test('Stop still cancels a pending provider stream in unlimited tests', { timeout: 10000 }, async t => {
  const { chat, cancelled } = await fixture(t, { rounds: 0, slowAnswer: true });
  const controller = new AbortController();
  const response = await chat(controller.signal);
  const reader = response.body.getReader();
  let received = '';
  while (!received.includes('event: model.info')) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    received += new TextDecoder().decode(value);
  }
  controller.abort();
  await reader.cancel().catch(() => {});
  for (let attempt = 0; attempt < 50 && !cancelled(); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cancelled(), true);
});
