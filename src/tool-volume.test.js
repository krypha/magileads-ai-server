import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { executeTool } from './tools.js';
import { sendScopeFixture } from '../test/scope-fixture.mjs';

const models = Array.from({ length: 30 }, (_, index) => ({
  id: index + 1, name: index === 29 ? 'Mission impossible — dernier modèle' : `Modèle ${index + 1}`,
  text: 'Contenu de prospection. '.repeat(200),
}));
const modelBody = `<p>${'Contenu complet. '.repeat(5000)}FIN_DU_MODELE</p>`;
const listData = { state: true, models_list: models, api_key: 'fixture-secret', bounced: 2525 };
const detailData = { state: true, model_profile: { id: 30, name: models.at(-1).name, html: modelBody,
  smtp_password: 'fixture-secret' } };

test('temporary tests preserve every template and its full body, while production still caps and secrets stay removed', async () => {
  const previousFetch = global.fetch;
  const previousExpiry = process.env.AI_TEST_UNLIMITED_UNTIL;
  global.fetch = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer fixture-caller');
    return Response.json(new URL(url).pathname === '/models/email' ? listData : detailData);
  };
  const run = (operation, extra = {}, context) => executeTool('run_operation', JSON.stringify({
    operation, ...(operation === 'get_email_model' ? { params: { id: 30 } } : {}), ...extra,
  }), { accessToken: 'fixture-caller' }, context);
  try {
    process.env.AI_TEST_UNLIMITED_UNTIL = '';
    const limited = await run('list_email_models', { enforceUsageLimits: false });
    assert.equal(JSON.parse(limited)._truncated, true); // Client arguments cannot lift limits.
    assert.ok(limited.length < 12_000);
    assert.ok(!limited.includes('fixture-secret') && !limited.includes('2525'));

    process.env.AI_TEST_UNLIMITED_UNTIL = new Date(Date.now() + 60_000).toISOString();
    const full = await run('list_email_models');
    assert.equal(JSON.parse(full)._truncated, undefined);
    assert.deepEqual(JSON.parse(full).data.models_list, models);
    assert.ok(full.includes(models.at(-1).name));
    const detail = await run('get_email_model');
    assert.equal(JSON.parse(detail).data.model_profile.html, modelBody);
    for (const raw of [full, detail]) assert.ok(!raw.includes('fixture-secret') && !raw.includes('2525'));

    // A request that started in test mode keeps the same execution policy
    // even if the deployment expiry is reached between two tool calls.
    process.env.AI_TEST_UNLIMITED_UNTIL = '';
    assert.deepEqual(JSON.parse(await run('list_email_models', {}, { enforceUsageLimits: false })).data.models_list, models);
  } finally {
    global.fetch = previousFetch;
    if (previousExpiry === undefined) delete process.env.AI_TEST_UNLIMITED_UNTIL;
    else process.env.AI_TEST_UNLIMITED_UNTIL = previousExpiry;
  }
});

test('HTTP chat forwards a large complete template list and body to the model instead of previews', { timeout: 10000 }, async t => {
  let modelCalls = 0;
  let fixtureError;
  const api = http.createServer(async (req, res) => {
    try {
      if (req.url === '/users/me') return res.end(JSON.stringify({ state: true, user_profile: { id: 391, level: 'user' } }));
      if (req.url === '/models/email') return res.end(JSON.stringify(listData));
      if (req.url === '/models/email/30') return res.end(JSON.stringify(detailData));
      if (req.url !== '/chat/completions') { res.writeHead(404); return res.end(); }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (sendScopeFixture(body, res)) return;
      modelCalls++;
      const outputs = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      let operation;
      if (outputs.length === 0) operation = { operation: 'list_email_models' };
      else {
        assert.deepEqual(outputs[0].data.models_list, models);
        assert.equal(outputs[0]._truncated, undefined);
        assert.ok(!JSON.stringify(outputs).includes('fixture-secret'));
        if (outputs.length === 1) operation = { operation: 'get_email_model', params: { id: 30 } };
        else assert.equal(outputs[1].data.model_profile.html, modelBody);
      }
      const delta = operation ? { tool_calls: [{ index: 0, id: `models-${modelCalls}`, function: {
        name: 'run_operation', arguments: JSON.stringify(operation),
      } }] } : { content: 'Les 30 modèles ont été lus, y compris Mission impossible — dernier modèle.' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) { fixtureError = error; res.writeHead(500); res.end(); }
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const apiUrl = `http://127.0.0.1:${api.address().port}`;
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], {
    env: { ...process.env, PORT: String(port), MAGILEADS_API_BASE: apiUrl, AI_API_URL: apiUrl,
      AI_API_KEY: 'fixture-key', AI_MODEL: 'fixture', AI_MODEL_INCLUDED: 'fixture',
      AI_TEST_UNLIMITED_UNTIL: new Date(Date.now() + 60_000).toISOString() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('server exited'); })]);
  const response = await fetch(`http://127.0.0.1:${port}/ai/chat`, {
    method: 'POST', headers: { Authorization: 'Bearer fixture-caller', 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Retrouve tous mes modèles Mission impossible, avec leur contenu complet.' }] }),
  });
  const stream = await response.text();
  if (fixtureError) throw fixtureError;
  assert.equal(response.status, 200);
  assert.equal(modelCalls, 3);
  assert.match(stream, /Les 30 modèles ont été lus/);
  assert.doesNotMatch(stream, /event: assistant.error/);
});
