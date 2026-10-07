import test from 'node:test';
import assert from 'node:assert/strict';
import { applyConnectionDegrees, normalizeConnectionDegrees } from './linkedin-connections.js';
import { normalizeTargeting, updateImportTargeting } from './import-targeting.js';
import { executeTool } from './tools.js';

const baseQuery = '(recentSearchParam:(id:42,doLogHistory:true),filters:List((type:REGION,values:List((id:105015875,text:France,selectionType:INCLUDED))),(type:CURRENT_TITLE,values:List((id:123,text:Directeur%20Marketing,selectionType:INCLUDED)))))';
const salesUrl = `https://www.linkedin.com/sales/search/people?query=${encodeURIComponent(baseQuery)}&sessionId=fixture`;

test('network degrees are independent of seniority and survive source switches', () => {
  const first = normalizeTargeting({ source: 'linkedin', job_titles: ['Marketing'], locations: ['France'], connection_degrees: [1] });
  assert.deepEqual(first.connection_degrees, [1]);
  assert.deepEqual(first.seniority, []);
  assert.deepEqual(updateImportTargeting({ source: 'sales_navigator' }, first).connection_degrees, [1]);
  assert.deepEqual(updateImportTargeting({ connection_degrees: [] }, first).connection_degrees, []);
  assert.equal(normalizeTargeting({ ...first, connection_degrees: ['F'] }).ready_to_launch, false);
  assert.deepEqual(normalizeConnectionDegrees([3, 1, 1]), [1, 3]);
});

test('standard URL keeps all facets and overwrites any prior network filter', () => {
  const original = 'https://www.linkedin.com/search/results/people/?keywords=Marketing&geoUrn=%5B%22105015875%22%5D&network=%5B%22S%22%5D';
  const result = applyConnectionDegrees(original, [1]);
  const url = new URL(result.url);
  assert.deepEqual(JSON.parse(url.searchParams.get('network')), ['F']);
  assert.equal(url.searchParams.get('keywords'), 'Marketing');
  assert.deepEqual(JSON.parse(url.searchParams.get('geoUrn')), ['105015875']);
  assert.equal(applyConnectionDegrees(original, []).url, original);
  assert.ok(applyConnectionDegrees(original, [4]).error);
});

test('Sales Navigator adds a single RELATIONSHIP facet and preserves nested filters', () => {
  const once = applyConnectionDegrees(salesUrl, [1], true);
  assert.equal(once.error, undefined);
  const query = new URL(once.url).searchParams.get('query');
  assert.match(query, /type:RELATIONSHIP,values:List\(\(id:F,selectionType:INCLUDED\)\)/);
  assert.ok(query.includes('(type:REGION,values:List((id:105015875,text:France,selectionType:INCLUDED)))'));
  assert.ok(query.includes('(type:CURRENT_TITLE,values:List((id:123,text:Directeur%20Marketing,selectionType:INCLUDED)))'));
  assert.equal(new URL(once.url).searchParams.get('sessionId'), 'fixture');
  assert.equal(applyConnectionDegrees(once.url, [1], true).url, once.url);
  const changed = new URL(applyConnectionDegrees(once.url, [2, 3], true).url).searchParams.get('query');
  assert.equal(changed.split('type:RELATIONSHIP').length, 2);
  assert.doesNotMatch(changed, /id:F,/);
  assert.match(changed, /id:S,/);
  assert.match(changed, /id:O,/);
  assert.ok(applyConnectionDegrees('https://www.linkedin.com/sales/search/people?query=broken', [1], true).error);
  assert.ok(applyConnectionDegrees('https://evil.example/search/results/people/', [1]).error);
});

test('both executors send first degree to extraction exactly once, without inventing generator fields', async () => {
  const previous = global.fetch;
  try {
    for (const sales of [false, true]) {
      const extractions = [];
      global.fetch = async (raw, options) => {
        const path = new URL(raw).pathname;
        if (path === '/integrations/linkedin') return Response.json({ linkedin_accounts_list: [
          { id: 7, is_valid: true, is_sales_navigator_account: true, checkpoint_required: false },
        ] });
        if (path === '/targeting/linkedin/locations/search') return Response.json({ locations: [{ id: 105015875, name_fr: 'France' }] });
        const body = JSON.parse(options.body);
        if (path.includes('/generate-')) {
          assert.equal(body.connection_degrees, undefined);
          assert.equal(body.network, undefined);
          const url = sales ? (body.locations ? salesUrl : salesUrl.replace('105015875', '999'))
            : 'https://www.linkedin.com/search/results/people/?keywords=Marketing&geoUrn=%5B%22105015875%22%5D';
          return Response.json({ state: true, linkedin_url: url });
        }
        if (path.includes('/extract-')) {
          extractions.push(body);
          const url = new URL(body.linkedin_people_search_url);
          if (sales) assert.match(url.searchParams.get('query'), /type:RELATIONSHIP,values:List\(\(id:F,selectionType:INCLUDED\)\)/);
          else assert.deepEqual(JSON.parse(url.searchParams.get('network')), ['F']);
          assert.equal(body.linkedin_account_id, 7);
          return Response.json({ state: true, contact_list_id: 42 });
        }
        throw Error(`Unexpected ${path}`);
      };
      const result = JSON.parse(await executeTool(sales ? 'run_sales_navigator_targeting' : 'run_linkedin_targeting', JSON.stringify({
        linkedin_account_id: 7, list_name: 'Relations directes', title: 'Marketing', location: 'France',
        titles: ['Marketing'], locations: ['France'], connection_degrees: [1],
      }), { apiKey: 'fixture' }, { profile: { permissions: { accessSearchAI: true } } }));
      assert.equal(result.status, 'extraction lancée');
      assert.deepEqual(result.criteria_applied.connection_degrees, [1]);
      assert.equal(extractions.length, 1);
    }
  } finally { global.fetch = previous; }
});

test('unknown URL shape never reaches extraction instead of silently dropping first degree', async () => {
  const previous = global.fetch;
  let extracts = 0;
  global.fetch = async (raw) => {
    const path = new URL(raw).pathname;
    if (path === '/integrations/linkedin') return Response.json({ linkedin_accounts_list: [{ id: 7, is_valid: true, is_sales_navigator_account: true }] });
    if (path.includes('/locations/search')) return Response.json({ locations: [{ id: 105015875, name_fr: 'France' }] });
    if (path.includes('/generate-')) return Response.json({ linkedin_url: 'https://www.linkedin.com/sales/search/people?query=broken' });
    extracts++;
    throw Error('No extraction allowed');
  };
  try {
    const result = JSON.parse(await executeTool('run_sales_navigator_targeting', JSON.stringify({
      linkedin_account_id: 7, list_name: 'Relations', titles: ['Marketing'], locations: ['France'], connection_degrees: [1],
    }), {}, { profile: { permissions: { accessSearchAI: true } } }));
    assert.ok(result.error);
    assert.equal(extracts, 0);
  } finally { global.fetch = previous; }
});
