import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('a confirmed LinkedIn search uses the selected account to choose Sales Navigator', { timeout: 20000 }, async () => {
  let permission = 1;
  let salesAccount = true;
  let wrongUrl = false;
  let expectedSource = 'sales_navigator';
  const calls = [];
  let fixtureError;
  const upstream = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      calls.push(req.url);
      const sales = expectedSource === 'sales_navigator';
      const url = sales && !wrongUrl
        ? 'https://www.linkedin.com/sales/search/people?query=fixture'
        : 'https://www.linkedin.com/search/results/people/?titleFreeText=DAF';
      const send = value => res.end(JSON.stringify(value));
      if (req.url === '/users/me') return send({ user_profile: { id: 1, level: 'super_admin', permissions: [
        { name: 'accessSearchAI', value: permission },
      ] } });
      if (req.url === '/integrations/linkedin') return send({ linkedin_accounts_list: [
        { id: 7, is_valid: true, is_sales_navigator_account: salesAccount, checkpoint_required: false },
      ] });
      if (req.url === '/contact-lists/42') return send({ contact_list_profile: { id: 42, name: 'Liste existante' } });
      if (req.url === '/targeting/linkedin/locations/search') {
        return send({ locations: [{ id: 105015875, name_fr: body.name }] });
      }
      const suffix = sales ? 'sales-navigator-peoples-search' : 'peoples-search';
      if (req.url === '/targeting/linkedin/generate-' + suffix + '-url') return send({
        linkedin_url: url + (sales && body.locations?.length ? '&geo=105015875' : ''),
      });
      if (req.url === '/targeting/linkedin/extract-' + suffix) {
        assert.equal(wrongUrl, false);
        assert.equal(body.linkedin_account_id, 7);
        assert.equal(body.contact_list_id, 42);
        assert.equal(body.linkedin_people_search_url, url + (sales ? '&geo=105015875' : ''));
        if (sales) assert.equal(body.linkedin_sales_navigator_search_url, body.linkedin_people_search_url);
        return send({ contact_list_id: 42 });
      }
      assert.equal(req.url, '/chat/completions');
      const prior = body.messages.filter(message => message.role === 'tool');
      const runTool = 'run_' + expectedSource + '_targeting';
      const otherTool = sales ? 'run_linkedin_targeting' : 'run_sales_navigator_targeting';
      const tools = body.tools.map(tool => tool.function.name);
      assert.ok(!tools.includes(otherTool));
      let delta;
      if (!prior.length) {
        delta = { tool_calls: [{ index: 0, id: 'update', function: { name: 'update_targeting', arguments: '{"source":"linkedin"}' } }] };
      } else if (prior.length === 1) {
        assert.equal(JSON.parse(prior[0].content).source, expectedSource);
        assert.ok(tools.includes(runTool));
        delta = { tool_calls: [{ index: 0, id: 'launch', function: { name: runTool, arguments: '{}' } }] };
      } else {
        if (wrongUrl) assert.equal(JSON.parse(prior[1].content).error_key, 'invalid_linkedin_search_url');
        delta = { content: wrongUrl ? 'Lien invalide.' : 'Recherche lancée.' };
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
    } catch (error) {
      fixtureError = error;
      res.writeHead(500);
      res.end();
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const reservation = http.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const upstreamUrl = 'http://127.0.0.1:' + upstream.address().port;
  const server = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], {
    env: { ...process.env, PORT: String(port), REDIS_URL: '', AI_API_KEY: 'fixture', AI_MODEL: 'fixture',
      AI_API_URL: upstreamUrl, MAGILEADS_API_BASE: upstreamUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const submit = () => fetch('http://127.0.0.1:' + port + '/ai/chat', {
    method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'import',
      messages: [{ role: 'user', content: 'Je cherche des DAF en France.' },
        { role: 'assistant', content: 'Cible LinkedIn à valider.' }, { role: 'user', content: 'Cible validée.' }],
      import_approval: { linkedin_account_id: 7, contact_list_id: 42,
        targeting: { source: 'linkedin', job_titles: ['DAF'], locations: ['France'], max_results: 100 } },
    }),
  });
  try {
    await Promise.race([once(server.stdout, 'data'), once(server, 'exit').then(() => { throw Error('Server exited'); })]);
    let response = await submit();
    assert.match(await response.text(), /event: assistant\.card/);
    assert.deepEqual(calls.filter(path => path.includes('/extract-')), ['/targeting/linkedin/extract-sales-navigator-peoples-search']);

    calls.length = 0;
    permission = false;
    response = await submit();
    assert.equal(response.status, 403);
    assert.equal((await response.json()).errorKey, 'sales_navigator_forbidden');
    assert.deepEqual(calls, ['/users/me', '/integrations/linkedin']);

    calls.length = 0;
    permission = 1;
    wrongUrl = true;
    response = await submit();
    assert.match(await response.text(), /Lien invalide/);
    assert.ok(!calls.some(path => path.includes('/extract-')));

    calls.length = 0;
    wrongUrl = false;
    salesAccount = false;
    expectedSource = 'linkedin';
    response = await submit();
    assert.match(await response.text(), /event: assistant\.card/);
    assert.deepEqual(calls.filter(path => path.includes('/extract-')), ['/targeting/linkedin/extract-peoples-search']);
    if (fixtureError) throw fixtureError;
  } finally {
    server.kill();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});
