import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { sendScopeFixture } from '../test/scope-fixture.mjs';

async function fixture(t, input) {
  const calls = [], mutations = [];
  const api = http.createServer(async (req, res) => {
    if (req.url === '/users/me') return res.end(JSON.stringify({ state: true, user_profile: { id: 391, level: 'admin' } }));
    if (req.url === '/chat/completions') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (sendScopeFixture(body, res)) return;
      calls.push(body);
      const first = calls.length === 1;
      const delta = first ? { tool_calls: [{ index: 0, id: 'document-1', function: { name: 'create_document', arguments: JSON.stringify(input) } }] }
        : { content: 'Le document est prêt à télécharger.' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    }
    if (req.method !== 'GET') mutations.push(req.url);
    res.writeHead(404); res.end();
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const apiUrl = `http://127.0.0.1:${api.address().port}`;
  let port;
  do {
    const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  } while (port <= 10080); // Windows can allocate ports blocked by fetch's browser-port policy.
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], {
    env: { ...process.env, PORT: String(port), MAGILEADS_API_BASE: apiUrl, AI_API_URL: apiUrl, AI_API_KEY: 'fixture-key', AI_MODEL: 'fixture', AI_TEST_UNLIMITED_UNTIL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('server exited'); })]);
  const chat = mode => fetch(`http://127.0.0.1:${port}/ai/chat`, {
    method: 'POST', headers: { Authorization: 'Bearer caller', 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, messages: [{ role: 'user', content: 'Exporte dans un fichier Excel la matrice de la liste 72138 que je viens de te donner.' }] }),
  });
  return { calls, mutations, chat };
}

test('HTTP SSE emits a complete downloadable card once and gives only its receipt to the model', { timeout: 10000 }, async t => {
  const input = { format: 'xlsx', title: 'Matrice', sections: [{ table: { columns: ['Métier', 'Contacts'], rows: Array.from({ length: 500 }, (_, i) => [`Marketing ${i}`, i]) } }] };
  const { calls, mutations, chat } = await fixture(t, input);
  const response = await chat('chat'), stream = await response.text();
  assert.equal(response.status, 200);
  const frames = stream.split('\n\n').filter(frame => frame.startsWith('event: assistant.card'));
  assert.equal(frames.length, 1);
  const card = JSON.parse(frames[0].split('\ndata: ')[1]);
  assert.equal(card.kind, 'document'); assert.equal(card.document.filename, 'Matrice.xlsx');
  assert.equal(card.document.sections[0].table.rows.length, 500);
  assert.deepEqual(mutations, []); assert.equal(calls.length, 2);
  assert.ok(calls[0].tools.some(tool => tool.function.name === 'create_document'));
  const receipt = JSON.parse(calls[1].messages.at(-1).content);
  assert.equal(receipt.rows, 500); assert.equal(receipt.document, undefined);
  assert.match(stream, /"label":"Préparation du document","status":"running","creates_list":false/);
  assert.match(stream, /"status":"completed"/);
  assert.doesNotMatch(stream, /event: assistant.changed|event: assistant.error/);
  assert.match(stream, /data: \[DONE\]/);
});

test('invalid document contents cannot produce a download card or any API mutation', { timeout: 10000 }, async t => {
  const { calls, mutations, chat } = await fixture(t, { format: 'xlsx', title: 'Rapport', sections: [{ paragraphs: ['Texte sans tableau'] }] });
  const stream = await (await chat('chat')).text();
  assert.doesNotMatch(stream, /event: assistant.card|event: assistant.changed/);
  assert.deepEqual(mutations, []);
  assert.equal(JSON.parse(calls[1].messages.at(-1).content).error, 'spreadsheet_requires_tables');
});
