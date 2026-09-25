import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_TOOLS, executeTool } from './tools.js';
import { cardsForTool, changesData } from './cards.js';
import { normalizeTargeting, validateDatabaseFilters } from './import-targeting.js';

const auth = { accessToken: 'fixture-token' };
const profile = { permissions: [
  { name: 'displayTargetingDatabase', value: true },
  { name: 'accessTargetingDatabase', value: true },
  { name: 'accessSearchAI', value: true },
  { name: 'useAlternativeTargeting', value: true },
] };

test('update_targeting has the exact event shape and is read-only', async () => {
  const previous = global.fetch;
  global.fetch = () => { throw new Error('update_targeting must not fetch'); };
  try {
    const result = JSON.parse(await executeTool('update_targeting', JSON.stringify({ source: 'google_maps', activity: 'dentistes', cities: ['Lyon'], ready_to_launch: false }), auth));
    assert.deepEqual(Object.keys(result), ['source', 'job_titles', 'seniority', 'sectors', 'company_size_min', 'company_size_max', 'locations', 'companies', 'activity', 'cities', 'exclusions', 'max_results', 'ready_to_launch', 'missing']);
    assert.equal(result.ready_to_launch, true);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(cardsForTool('update_targeting', JSON.stringify(result)), []);
    assert.equal(changesData('update_targeting', JSON.stringify(result)), false);
    assert.equal(normalizeTargeting({ source: 'google_maps', activity: 'dentistes' }).ready_to_launch, false);
    assert.equal(normalizeTargeting({ source: 'linkedin', sectors: ['Santé'], locations: ['France'] }).ready_to_launch, false);
    assert.equal(normalizeTargeting({ source: 'database', company_size_min: 11 }).ready_to_launch, true);
  } finally { global.fetch = previous; }
});

test('database preview resolves locations, extraction uses the same filters and checks permission', async () => {
  const previous = global.fetch;
  const paths = [];
  global.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    paths.push(path);
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    const body = JSON.parse(options.body ?? '{}');
    if (path === '/targeting/database/locations/search') {
      assert.equal(body.name, 'Paris');
      return Response.json({ state: true, locations: [{ name: 'Paris, France' }] });
    }
    if (path === '/targeting/database/count-preview') {
      assert.deepEqual(body.filters, [{ field: 'contact_location', contains: ['Paris, France'] }, { field: 'phone', exists: true }]);
      return Response.json({ state: true, number_of_contacts: { count: 42 } });
    }
    if (path === '/targeting/database/extract') {
      assert.deepEqual(body, {
        contact_list_name: 'Paris prospects', contact_list_id: null, max_results: 10000,
        filters: [{ field: 'contact_location', contains: ['Paris, France'] }, { field: 'phone', exists: true }],
        contact_list_country: null, contact_list_language: 'FRA',
      });
      return Response.json({ state: true, contact_list_id: 99 });
    }
    throw new Error(`unexpected ${path}`);
  };
  const filters = [{ field: 'contact_location', contains: ['Paris'] }, { field: 'phone', exists: true }];
  try {
    const blocked = JSON.parse(await executeTool('count_database_targeting', JSON.stringify({ filters }), auth, { profile: {} }));
    assert.ok(blocked.error);
    assert.equal(paths.length, 0);
    const preview = JSON.parse(await executeTool('count_database_targeting', JSON.stringify({ filters }), auth, { profile }));
    assert.equal(preview.count, 42);
    assert.equal(changesData('count_database_targeting', JSON.stringify(preview)), false);
    const result = await executeTool('run_database_targeting', JSON.stringify({ filters, list_name: 'Paris prospects', max_results: 99999 }), auth, { profile });
    assert.equal(JSON.parse(result).list_id, 99);
    assert.equal(changesData('run_database_targeting', result), true);
    assert.deepEqual(cardsForTool('run_database_targeting', result), [{ kind: 'lists', items: [{ id: 99, name: 'Paris prospects' }] }]);
    assert.equal(paths.filter(path => path === '/targeting/database/extract').length, 1);
  } finally { global.fetch = previous; }
});

test('Sales Navigator verifies facets in generated URLs, uses only a real account and alternative extraction', async () => {
  const previous = global.fetch;
  let extracts = 0;
  global.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(options.body ?? '{}');
    if (path === '/integrations/linkedin') return Response.json({ state: true, linkedin_accounts_list: [
      { id: 7, name: 'Sales Team', is_valid: true, checkpoint_required: false, is_sales_navigator_account: true },
      { id: 8, name: 'Classic', is_valid: true, checkpoint_required: false, is_sales_navigator_account: false },
    ] });
    if (path === '/targeting/linkedin/locations/search') return Response.json({ state: true, locations: [{ id: 105015875, name_fr: 'France' }] });
    if (path === '/targeting/linkedin/generate-sales-navigator-peoples-search-url') {
      const params = new URLSearchParams({ geoIncluded: body.locations?.[0] ?? '', titleIncluded: body.current_titles?.[0] ?? '' });
      if (body.company_head_counts?.length) params.set('companySize', body.company_head_counts[0]);
      // Fixture deliberately ignores seniority. The executor must report it as ignored.
      return Response.json({ state: true, search_url: `https://www.linkedin.com/sales/search/people?${params}&rsLogId=${Math.random()}` });
    }
    if (path === '/targeting/linkedin/extract-sales-navigator-peoples-search-alternative') {
      extracts++;
      assert.equal(body.linkedin_account_id, 7);
      assert.equal(body.contact_list_name, 'Dirigeants France');
      assert.equal(body.contact_list_id, null);
      assert.match(body.linkedin_sales_navigator_search_url, /companySize=51-200/);
      assert.equal(body.linkedin_people_search_url, body.linkedin_sales_navigator_search_url);
      assert.equal(body.generate_email, true);
      assert.equal(body.max_results, 1000);
      return Response.json({ state: true, contact_list_id: 77 });
    }
    throw new Error(`unexpected ${path}`);
  };
  try {
    const card = JSON.parse(await executeTool('ask_linkedin_account', '{"sales_navigator_only":true}', auth, { profile }));
    assert.deepEqual(card.accounts.map(account => account.id), [7]);
    const args = { titles: ['Directeur'], locations: ['France'], company_head_counts: ['51-200'], seniority_levels: ['director'], linkedin_account_id: 7, list_name: 'Dirigeants France', max_results: 1200 };
    const result = JSON.parse(await executeTool('run_sales_navigator_targeting', JSON.stringify(args), auth, { profile }));
    assert.equal(result.list_id, 77);
    assert.deepEqual(result.criteria_applied.company_head_counts, ['51-200']);
    assert.deepEqual(result.criteria_applied.seniority_levels, []);
    assert.match(result.note, /Filtres ignorés/);
    assert.equal(extracts, 1);
    const invalid = JSON.parse(await executeTool('run_sales_navigator_targeting', JSON.stringify({ ...args, linkedin_account_id: 8 }), auth, { profile }));
    assert.ok(invalid.error);
    assert.equal(extracts, 1);
  } finally { global.fetch = previous; }
});

test('database filter validation rejects unsupported fields, operators and sizes', () => {
  assert.ok(validateDatabaseFilters([{ field: 'job_title', equals: ['CEO'] }]).error);
  assert.ok(validateDatabaseFilters([{ field: 'company_size', contains: ['50-200'] }]).error);
  assert.ok(validateDatabaseFilters([{ field: 'zip_code', contains: ['75'] }]).error);
  assert.ok(AI_TOOLS.some(tool => tool.function.name === 'run_sales_navigator_targeting'));
});

test('Google Maps and classic LinkedIn append to an owned list without creating a new one', async () => {
  const previous = global.fetch;
  const extracts = [];
  global.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(options.body ?? '{}');
    if (path === '/contact-lists/55') return Response.json({ state: true, contact_list_profile: { id: 55, name: 'Liste existante' } });
    if (path === '/integrations/linkedin') return Response.json({ state: true, linkedin_accounts_list: [
      { id: 7, is_valid: true, checkpoint_required: false, is_sales_navigator_account: false },
    ] });
    if (path === '/targeting/linkedin/locations/search') return Response.json({ state: true, locations: [{ id: 123, name_fr: 'Paris' }] });
    if (path === '/targeting/linkedin/generate-peoples-search-url') return Response.json({ state: true, linkedin_url: 'https://www.linkedin.com/search/results/people/?keywords=CEO' });
    if (path === '/targeting/google/generate-maps-search-urls') return Response.json({ state: true, google_maps_search_urls: ['https://www.google.com/maps/search/dentistes+Paris'] });
    if (path === '/targeting/google/extract-maps-search' || path === '/targeting/linkedin/extract-peoples-search') {
      extracts.push({ path, body });
      assert.equal(body.contact_list_name, null);
      assert.equal(body.contact_list_id, 55);
      return Response.json({ state: true, contact_list_id: 55 });
    }
    throw new Error(`unexpected ${path}`);
  };
  try {
    const maps = await executeTool('run_google_maps_targeting', JSON.stringify({ search: 'dentistes', locations: ['Paris'], contact_list_id: 55 }), auth);
    assert.deepEqual(cardsForTool('run_google_maps_targeting', maps), [{ kind: 'lists', items: [{ id: 55, name: 'Liste existante' }] }]);
    const linkedin = await executeTool('run_linkedin_targeting', JSON.stringify({ title: 'CEO', location: 'Paris', linkedin_account_id: 7, contact_list_id: 55 }), auth);
    assert.equal(JSON.parse(linkedin).criteria_applied.location_used, 'Paris');
    assert.equal(extracts.length, 2);
  } finally { global.fetch = previous; }
});
