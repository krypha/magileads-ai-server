import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupLinkedinLocations, resolveLinkedinLocations } from './import-targeting.js';
import { AI_TOOLS, executeTool, CREATES_LIST } from './tools.js';
import { cardsForTool, changesData } from './cards.js';

const auth = { apiKey: 'fixture-switched-account' };
const region = { id: '104246759', name_fr: 'Île-de-France, France', name_en: 'Île-de-France, France' };
const other = { id: 123, name_fr: 'Pontoise, Île-de-France, France', name_en: 'Pontoise, Île-de-France, France' };
const profile = { permissions: [{ name: 'accessSearchAI', value: true }] };

test('both targeting engines resolve the actual qualified region among fuzzy results', async () => {
  const previous = global.fetch;
  const extracts = [];
  global.fetch = async (url, options) => {
    assert.equal(options.headers['X-API-Key'], auth.apiKey);
    assert.equal(options.headers.Authorization, undefined);
    const path = new URL(url).pathname, body = JSON.parse(options.body ?? '{}');
    if (path === '/integrations/linkedin') return Response.json({ linkedin_accounts_list: [
      { id: 7, is_valid: true, checkpoint_required: false, is_sales_navigator_account: true },
    ] });
    if (path === '/contact-lists/55') return Response.json({ contact_list_profile: { id: 55, name: 'Existing destination' } });
    if (path === '/targeting/linkedin/locations/search') {
      assert.equal(body.name, 'Ile de France');
      return Response.json({ state: true, locations: [other, region, region] });
    }
    if (path.endsWith('/generate-peoples-search-url')) {
      assert.deepEqual(body.locations, [104246759]);
      return Response.json({ linkedin_url: `https://www.linkedin.com/search/results/people/?geoUrn=${encodeURIComponent(JSON.stringify(body.locations))}` });
    }
    if (path.endsWith('/generate-sales-navigator-peoples-search-url')) {
      if (body.locations) assert.deepEqual(body.locations, ['104246759']);
      return Response.json({ linkedin_url: `https://www.linkedin.com/sales/search/people?geoIncluded=${body.locations?.join(',') ?? ''}` });
    }
    if (path.includes('/extract-')) {
      extracts.push(body);
      assert.equal(body.contact_list_id, 55);
      assert.equal(body.contact_list_name, null);
      return Response.json({ state: true, contact_list_id: 55 });
    }
    throw Error(`Unexpected ${path}`);
  };
  try {
    for (const [name, args] of [
      ['run_linkedin_targeting', { title: 'CMO', location: 'Ile de France' }],
      ['run_sales_navigator_targeting', { titles: ['CMO'], locations: ['Ile de France'] }],
    ]) {
      const result = JSON.parse(await executeTool(name, JSON.stringify({ ...args, linkedin_account_id: 7, contact_list_id: 55 }), auth, { profile }));
      assert.equal(result.status, 'extraction lancée');
      assert.equal(result.list_id, 55);
      const applied = result.criteria_applied;
      assert.equal(applied.location_used ?? applied.locations[0].used, region.name_fr);
    }
    assert.equal(extracts.length, 2);
  } finally { global.fetch = previous; }
});

test('English names resolve against the English label and Unicode hyphens match French regions', async () => {
  const previous = global.fetch;
  global.fetch = async (_url, options) => Response.json({ locations: JSON.parse(options.body).name === 'London'
    ? [{ id: 2, name_fr: 'Londres, Ontario, Canada', name_en: 'London, Ontario, Canada' }, { id: 1, name_fr: 'Londres', name_en: 'London' }]
    : [other, region] });
  try {
    assert.equal((await resolveLinkedinLocations(['London'], auth)).locations[0].id, 1);
    assert.equal((await resolveLinkedinLocations(['Île‑de‑France'], auth)).locations[0].id, 104246759);
  } finally { global.fetch = previous; }
});

test('ambiguous cities and unrelated singleton matches cannot cause an extraction', async () => {
  const previous = global.fetch;
  let lookupResponse = [
    { id: 1, name_fr: 'Paris, Île-de-France, France' },
    { id: 2, name_fr: 'Paris, Texas, États-Unis' },
  ];
  const paths = [];
  global.fetch = async (url) => {
    const path = new URL(url).pathname; paths.push(path);
    if (path === '/integrations/linkedin') return Response.json({ linkedin_accounts_list: [{ id: 7, is_valid: true, is_sales_navigator_account: true }] });
    if (path === '/targeting/linkedin/locations/search') return Response.json({ locations: lookupResponse });
    throw Error(`Should not reach generation/extraction: ${path}`);
  };
  try {
    for (const name of ['run_linkedin_targeting', 'run_sales_navigator_targeting']) {
      const result = JSON.parse(await executeTool(name, JSON.stringify({ title: 'CMO', titles: ['CMO'], location: 'Paris', locations: ['Paris'], linkedin_account_id: 7, list_name: 'Destination' }), auth, { profile }));
      assert.equal(result.error_key, 'linkedin_location_ambiguous');
      assert.equal(result.candidates.length, 2);
    }
    lookupResponse = [{ id: 1, name_fr: 'Lyon, France' }];
    assert.ok((await resolveLinkedinLocations(['Paris'], auth)).error);
    assert.ok(paths.every(path => !path.includes('generate-') && !path.includes('extract-')));
  } finally { global.fetch = previous; }
});

test('permission and transport failures retain their cause, not an unknown-place diagnosis', async () => {
  const previous = global.fetch;
  try {
    for (const [status, code] of [[403, 'insufficient_level_required'], [401, 'token_expired'], [502, 'service_unavailable']]) {
      global.fetch = async () => Response.json({ state: false, state_message: code }, { status });
      const result = await resolveLinkedinLocations(['Île-de-France'], auth);
      assert.equal(result.error_key, code);
      assert.equal(result.status_code, status);
      assert.doesNotMatch(result.error, /«.*» introuvable/);
    }
    global.fetch = async () => { throw Error('offline'); };
    assert.equal((await resolveLinkedinLocations(['Paris'], auth)).error_key, 'network_error');
    global.fetch = async () => Response.json({ state: true, locations: [] });
    assert.equal((await resolveLinkedinLocations(['Unknown'], auth)).error_key, 'linkedin_location_not_found');
    global.fetch = async () => Response.json({ state: true });
    assert.equal((await lookupLinkedinLocations('Paris', auth)).error_key, 'invalid_locations_response');
  } finally { global.fetch = previous; }
});

test('location lookup is an advertised read-only tool with no card, creation or change event', async () => {
  const previous = global.fetch;
  global.fetch = async () => Response.json({ locations: [region] });
  try {
    const name = 'search_linkedin_locations';
    assert.ok(AI_TOOLS.some(tool => tool.function.name === name));
    assert.ok(!CREATES_LIST.includes(name));
    const raw = await executeTool(name, '{"name":"Île-de-France"}', auth);
    assert.equal(JSON.parse(raw).locations[0].name_fr, region.name_fr);
    assert.equal(changesData(name, raw), false);
    assert.deepEqual(cardsForTool(name, raw), []);
  } finally { global.fetch = previous; }
});
