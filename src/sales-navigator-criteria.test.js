import test from 'node:test';
import assert from 'node:assert/strict';
import { runSalesNavigator, normalizeTargeting, updateImportTargeting } from './import-targeting.js';
import { approvedToolArgs, parseImportApproval } from './import-approval.js';
import { SALES_ARRAY_FIELDS, SALES_FLAGS, SALES_TOOL_FIELDS, headCountsForCriteria } from './sales-navigator-criteria.js';
import { AI_TOOLS } from './tools.js';

const target = {
  source: 'sales_navigator', job_titles: ['Directeur Marketing'], locations: ['France'], sectors: ['4'], companies: ['Microsoft'], seniority: ['director'],
  company_head_counts: ['51-200'], company_headquarters: ['France'], job_titles_exclude: ['Assistant', 'Stagiaire'], locations_exclude: ['Paris'],
  sectors_exclude: ['104'], seniority_exclude: ['entry_level'], companies_exclude: ['Google'], company_headquarters_exclude: ['États-Unis'],
  recently_changed_job: true, posted_on_linkedin: true, in_the_news: true, max_results: 50,
};
const auth = { apiKey: 'fixture-account-only' };
const profile = { permissions: [{ name: 'accessSearchAI', value: true }] };

test('every documented new facet is advertised, retained through source switches and enforced from approval', () => {
  const criteria = normalizeTargeting(target);
  assert.equal(criteria.ready_to_launch, true);
  const restored = updateImportTargeting({ source: 'sales_navigator' }, updateImportTargeting({ source: 'google_maps', activity: 'dentistes', cities: ['Paris'] }, criteria));
  for (const key of [...Object.keys(SALES_ARRAY_FIELDS), ...Object.keys(SALES_FLAGS)]) assert.deepEqual(restored[key], criteria[key]);
  const approval = parseImportApproval({ targeting: target, contact_list_id: 42, linkedin_account_id: 7 });
  assert.ok(approval);
  const args = JSON.parse(approvedToolArgs('run_sales_navigator_targeting', JSON.stringify({ titles_exclude: [], companies_exclude: ['Other'], posted_on_linkedin: false, company_head_counts: ['10001-above'] }), approval));
  for (const key of Object.keys(SALES_ARRAY_FIELDS)) assert.deepEqual(args[SALES_TOOL_FIELDS[key]], target[key]);
  for (const key of Object.keys(SALES_FLAGS)) assert.equal(args[key], true);
  const empty = parseImportApproval({ targeting: { source: 'sales_navigator', locations: ['France'] }, list_name: 'test', linkedin_account_id: 7 });
  const clean = JSON.parse(approvedToolArgs('run_sales_navigator_targeting', JSON.stringify({ titles_exclude: ['Invented'], in_the_news: true }), empty));
  assert.deepEqual(clean.titles_exclude, []);
  assert.equal(clean.in_the_news, null);
  const schema = AI_TOOLS.find(item => item.function.name === 'update_targeting').function.parameters.properties;
  for (const key of Object.keys(target).filter(key => key in SALES_ARRAY_FIELDS || key in SALES_FLAGS)) assert.ok(schema[key]);
  assert.equal(normalizeTargeting({ source: 'sales_navigator', company_headquarters: ['France'] }).ready_to_launch, true);
  assert.equal(normalizeTargeting({ source: 'sales_navigator', posted_on_linkedin: true }).ready_to_launch, true);
  assert.equal(normalizeTargeting({ ...target, posted_on_linkedin: 'yes' }).ready_to_launch, false);
  assert.equal(normalizeTargeting({ ...target, companies_exclude: Array(7).fill('X') }).ready_to_launch, false);
  assert.deepEqual(headCountsForCriteria({ company_size_min: 51, company_size_max: 200 }), ['51-200']);
});

async function fixture(t, ignored) {
  const previous = global.fetch;
  t.after(() => { global.fetch = previous; });
  const generated = [], extracted = [];
  global.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(options.body ?? '{}');
    assert.equal(options.headers['X-API-Key'], auth.apiKey);
    if (path === '/integrations/linkedin') return Response.json({ linkedin_accounts_list: [{ id: 7, is_valid: true, checkpoint_required: false, is_sales_navigator_account: true }] });
    if (path === '/contact-lists/42') return Response.json({ contact_list_profile: { id: 42, name: 'Existing' } });
    if (path === '/targeting/linkedin/locations/search') {
      const id = { France: 105015875, Paris: 104246759, 'États-Unis': 103644278 }[body.name];
      return Response.json({ locations: id ? [{ id, name_fr: body.name }] : [] });
    }
    if (path === '/targeting/linkedin/generate-sales-navigator-peoples-search-url') {
      generated.push(body);
      const effective = { ...body };
      if (ignored) {
        if (Array.isArray(effective[ignored])) effective[ignored] = effective[ignored].filter(value => value !== 'Stagiaire');
        else delete effective[ignored];
        if (Array.isArray(effective[ignored]) && !effective[ignored].length) delete effective[ignored];
      }
      return Response.json({ linkedin_url: `https://www.linkedin.com/sales/search/people?criteria=${encodeURIComponent(JSON.stringify(effective))}` });
    }
    if (path === '/targeting/linkedin/extract-sales-navigator-peoples-search') { extracted.push(body); return Response.json({ contact_list_id: 42 }); }
    throw Error(`Unexpected ${path}`);
  };
  return { generated, extracted };
}

test('all 16 generator fields reach the verified URL and one extraction into the existing list', async t => {
  const { generated, extracted } = await fixture(t);
  const approval = parseImportApproval({ targeting: target, contact_list_id: 42, linkedin_account_id: 7 });
  const args = JSON.parse(approvedToolArgs('run_sales_navigator_targeting', '{}', approval));
  const result = await runSalesNavigator(args, auth, profile);
  assert.equal(result.status, 'extraction lancée');
  assert.equal(result.list_id, 42);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].contact_list_name, null);
  const payload = JSON.parse(new URL(extracted[0].linkedin_sales_navigator_search_url).searchParams.get('criteria'));
  assert.equal(Object.keys(payload).length, 16);
  assert.deepEqual(payload.company_headquarters, [105015875]);
  assert.deepEqual(payload.locations_exclude, [104246759]);
  assert.deepEqual(payload.company_headquarters_exclude, [103644278]);
  assert.deepEqual(payload.current_titles_exclude, ['Assistant', 'Stagiaire']);
  assert.deepEqual(payload.industries_exclude, [104]);
  assert.equal(payload.posted_on_linkedin, true);
  assert.ok(generated.length > 2);
  assert.deepEqual(result.criteria_applied.current_titles_exclude, ['Assistant', 'Stagiaire']);
});

for (const ignored of ['current_titles_exclude', 'posted_on_linkedin']) test(`an ignored ${ignored} value cancels extraction instead of widening the approved target`, async t => {
  const { extracted } = await fixture(t, ignored);
  const approval = parseImportApproval({ targeting: target, list_name: 'Do not create', linkedin_account_id: 7 });
  const result = await runSalesNavigator(JSON.parse(approvedToolArgs('run_sales_navigator_targeting', '{}', approval)), auth, profile);
  assert.ok(result.error);
  assert.deepEqual(result.unsupported_filters, [ignored]);
  assert.equal(extracted.length, 0);
});

for (const single of [{ company_headquarters: ['France'] }, { posted_on_linkedin: true }, { industries: ['4'] }, { company_head_counts: ['51-200'] }]) test(`a standalone ${Object.keys(single)[0]} search does not require a fabricated contact location`, async t => {
  const { extracted } = await fixture(t);
  const result = await runSalesNavigator({ ...single, contact_list_id: 42, linkedin_account_id: 7 }, auth, profile);
  assert.equal(result.status, 'extraction lancée');
  assert.equal(extracted.length, 1);
});

test('a unique industry prefix resolves to the actual catalog ID for exclusions', async t => {
  const { extracted } = await fixture(t);
  const result = await runSalesNavigator({ titles: ['Directeur'], industries_exclude: ['Recrutement'], contact_list_id: 42, linkedin_account_id: 7 }, auth, profile);
  assert.equal(result.status, 'extraction lancée');
  const payload = JSON.parse(new URL(extracted[0].linkedin_sales_navigator_search_url).searchParams.get('criteria'));
  assert.deepEqual(payload.industries_exclude, [104]);
});
