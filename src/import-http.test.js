import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('import mode streams criteria, refuses extraction before approval, then launches once with the approved name', { timeout: 20000 }, async () => {
  let extracts = 0;
  let generators = 0;
  let providerError;
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/users/me') return res.end(JSON.stringify({ state: true, user_profile: { id: 1, first_name: 'Iris' } }));
    if (req.url === '/contact-lists/42') return res.end(JSON.stringify({ state: true, contact_list_profile: { id: 42, name: 'Liste existante' } }));
    let raw = ''; for await (const chunk of req) raw += chunk;
    try {
      if (req.url === '/targeting/google/generate-maps-search-urls') {
        generators++;
        return res.end(JSON.stringify({ state: true, google_maps_search_urls: ['https://www.google.com/maps/search/dentistes+Lyon'] }));
      }
      if (req.url === '/targeting/google/extract-maps-search') {
        extracts++;
        const body = JSON.parse(raw);
        if (body.contact_list_id === 42) {
          assert.equal(body.contact_list_name, null);
          return res.end(JSON.stringify({ state: true, contact_list_id: 42 }));
        }
        assert.equal(body.contact_list_name, 'Prospects Lyon');
        assert.equal(body.contact_list_id, null);
        return res.end(JSON.stringify({ state: true, contact_list_id: 70657 }));
      }
      if (req.url === '/chat/completions') {
        const body = JSON.parse(raw);
        assert.ok(!raw.includes('caller-secret'));
        const tools = body.messages.filter(item => item.role === 'tool');
        let delta;
        if (body.tool_choice === 'auto' && !tools.length) {
          assert.ok(!body.tools.some(tool => ['update_targeting', 'count_database_targeting', 'run_database_targeting', 'run_sales_navigator_targeting'].includes(tool.function.name)));
          delta = { content: 'Discussion normale.' };
        } else if (!tools.length) {
          assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'update_targeting' } });
          delta = { tool_calls: [{ index: 0, id: 'criteria', function: { name: 'update_targeting', arguments: JSON.stringify({ source: 'google_maps', activity: 'dentistes', cities: ['Lyon'] }) } }] };
        } else if (tools.length < 3) {
          assert.equal(body.tool_choice, 'auto');
          delta = { tool_calls: [{ index: 0, id: `launch${tools.length}`, function: { name: 'run_google_maps_targeting', arguments: JSON.stringify({ search: 'dentistes', locations: ['Lyon'], list_name: 'Nom inventé' }) } }] };
        } else {
          delta = { content: 'Recherche lancée.' };
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
      }
      res.writeHead(404); res.end();
    } catch (error) {
      providerError = error;
      res.writeHead(500); res.end();
    }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], {
    env: { ...process.env, PORT: String(port), AI_API_KEY: 'provider-test', AI_MODEL: 'fixture', AI_API_URL: upstreamUrl, MAGILEADS_API_BASE: upstreamUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chat = async (messages, mode, importApproval) => {
    const response = await fetch(`http://127.0.0.1:${port}/ai/chat`, {
      method: 'POST', headers: { Authorization: 'Bearer caller-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(mode ? { mode } : {}), ...(importApproval ? { import_approval: importApproval } : {}), messages }),
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('server exited'); })]);
    const chatMode = await chat([{ role: 'user', content: 'Bonjour.' }], 'chat');
    assert.doesNotMatch(chatMode, /event: targeting.criteria/);
    const first = [{ role: 'user', content: '[Contexte : je suis sur la page de création de liste de prospects. Attends ma validation.] Je cherche des dentistes à Lyon.' }];
    const before = await chat(first);
    assert.match(before, /event: targeting.criteria/);
    assert.match(before, /"ready_to_launch":true/);
    assert.doesNotMatch(before, /event: assistant.card/);
    assert.equal(generators, 0);
    assert.equal(extracts, 0);

    const approved = [...first, { role: 'assistant', content: 'Cible : dentistes à Lyon. Validez ?' },
      { role: 'user', content: 'La cible me convient : crée la liste « Prospects Lyon » et lance la recherche.' }];
    const after = await chat(approved, 'import');
    assert.match(after, /event: targeting.criteria/);
    assert.match(after, /"creates_list":true/);
    assert.match(after, /event: assistant.card/);
    assert.match(after, /"kind":"lists","items":\[\{"id":70657,"name":"Prospects Lyon"\}\]/);
    assert.equal(generators, 1);
    assert.equal(extracts, 1);
    const localized = [...first, { role: 'assistant', content: 'Cible : dentistes à Lyon. Validez ?' },
      { role: 'user', content: 'The target works for me: add the results to “Liste existante” (ID 42) and launch the search.' }];
    const existing = await chat(localized, 'import', { contact_list_id: 42 });
    assert.match(existing, /"kind":"lists","items":\[\{"id":42,"name":"Liste existante"\}\]/);
    assert.equal(generators, 2);
    assert.equal(extracts, 2);
    if (providerError) throw providerError;
  } finally {
    child.kill();
    await new Promise(resolve => upstream.close(resolve));
  }
});
