import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool } from './tools.js';
import { changesData, cardsForTool } from './cards.js';

const auth = { apiKey: 'fixture-switched-user' };
const profile = { permissions: [{ name: 'accessSearchAI', value: true }] };
const titles = ['Directeur Marketing', 'CMO', 'Head of Marketing', 'Marketing Director', 'VP Marketing', 'Responsable Marketing'];
const args = { titles, locations: ['Île-de-France'], industries: ['Software Development'],
  company_head_counts: ['51-200'], seniority_levels: ['director'], linkedin_account_id: 11230,
  contact_list_id: 72654, max_results: 100 };

function commonResponse(path) {
  if (path === '/integrations/linkedin') return Response.json({ linkedin_accounts_list: [
    { id: 11230, is_valid: true, is_sales_navigator_account: true, checkpoint_required: false },
  ] });
  if (path === '/contact-lists/72654') return Response.json({ contact_list_profile: { id: 72654, name: 'Test R' } });
  if (path === '/targeting/linkedin/locations/search') return Response.json({ locations: [
    { id: 104246759, name_fr: 'Île-de-France, France' },
  ] });
  return null;
}

test('Sales Navigator uses v4 JSON integer IDs, linkedin_url and exactly one extraction into the existing list', async () => {
  const previous = global.fetch;
  const generations = [], extractions = [];
  global.fetch = async (url, options) => {
    assert.equal(options.headers['X-API-Key'], auth.apiKey);
    const path = new URL(url).pathname;
    const known = commonResponse(path);
    if (known) return known;
    const body = JSON.parse(options.body);
    if (path.endsWith('/generate-sales-navigator-peoples-search-url')) {
      generations.push(body);
      assert.deepEqual(body.current_titles, titles);
      for (const field of ['locations', 'industries']) {
        assert.ok((body[field] ?? []).every(Number.isSafeInteger), `${field} must use the v4 integer schema`);
      }
      assert.equal(body.linkedin_account_id, undefined);
      const query = new URLSearchParams();
      for (const [key, values] of Object.entries(body)) query.set(key, JSON.stringify(values));
      return Response.json({ state: true, linkedin_url: `https://www.linkedin.com/sales/search/people?${query}` });
    }
    if (path.endsWith('/extract-sales-navigator-peoples-search')) {
      extractions.push(body);
      assert.equal(body.contact_list_id, 72654);
      assert.equal(body.contact_list_name, null);
      assert.equal(body.linkedin_account_id, 11230);
      assert.equal(body.linkedin_sales_navigator_search_url, body.linkedin_people_search_url);
      assert.equal(body.max_results, 100);
      assert.equal(body.generate_email, true);
      return Response.json({ state: true, contact_list_id: 72654 });
    }
    throw Error(`Unexpected endpoint ${path}`);
  };
  try {
    const raw = await executeTool('run_sales_navigator_targeting', JSON.stringify(args), auth, { profile });
    const result = JSON.parse(raw);
    assert.equal(result.status, 'extraction lancée');
    assert.equal(result.list_id, 72654);
    assert.deepEqual(result.criteria_applied.industries, [{ id: 4, name: 'Développement de logiciels' }]);
    assert.deepEqual(result.criteria_applied.seniority_levels, ['director']);
    assert.deepEqual(generations[0].locations, [104246759]);
    assert.ok(generations.some(body => body.industries?.[0] === 4));
    assert.equal(extractions.length, 1);
    assert.equal(changesData('run_sales_navigator_targeting', raw), true);
  } finally { global.fetch = previous; }
});

test('generation failures preserve the API cause for both engines and never reach extraction', async () => {
  const previous = global.fetch;
  try {
    for (const engine of ['run_sales_navigator_targeting', 'run_linkedin_targeting']) {
      for (const [status, code] of [[400, 'validation_exception'], [403, 'unauthorized_search_ai'], [401, 'token_expired'], [502, 'service_unavailable'], [200, null]]) {
        const paths = [];
        global.fetch = async (url) => {
          const path = new URL(url).pathname; paths.push(path);
          const known = commonResponse(path);
          if (known) return known;
          if (path.includes('/generate-')) return Response.json(code
            ? { state: false, state_message: code, errors: ['raw private validation input'] }
            : { state: true }, { status });
          throw Error(`No extraction allowed: ${path}`);
        };
        const raw = await executeTool(engine, JSON.stringify({ ...args, title: titles[0], location: args.locations[0] }), auth, { profile });
        const result = JSON.parse(raw);
        assert.equal(result.stage, 'search_url_generation');
        assert.equal(result.error_key, code ?? 'invalid_linkedin_search_url');
        assert.equal(result.status_code, status);
        assert.doesNotMatch(raw, /raw private validation input/);
        assert.ok(paths.every(path => !path.includes('/extract-')));
        assert.equal(changesData(engine, raw), false);
        assert.deepEqual(cardsForTool(engine, raw), []);
      }
    }
  } finally { global.fetch = previous; }
});
