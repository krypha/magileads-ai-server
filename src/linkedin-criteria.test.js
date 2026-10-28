import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedToolArgs, parseImportApproval } from './import-approval.js';
import { executeTool } from './tools.js';
import { linkedinValues, linkedinBooleanOr } from './linkedin-criteria.js';

const auth = { accessToken: 'fixture-account' };
const target = { source: 'linkedin', job_titles: ['CEO', 'DG'], companies: ['Magileads', 'Darty'], locations: ['France', 'Belgique'], max_results: 50 };
const approved = source => parseImportApproval({ targeting: { ...target, source }, linkedin_account_id: 7, contact_list_id: 42 });

test('reviewed arrays override forged scalar and array arguments in both search engines', () => {
  for (const source of ['linkedin', 'sales_navigator']) {
    const tool = source === 'linkedin' ? 'run_linkedin_targeting' : 'run_sales_navigator_targeting';
    const args = JSON.parse(approvedToolArgs(tool, JSON.stringify({ title: 'CEO', company: 'Other', titles: ['CEO'], companies: ['Other'], locations: ['Other'] }), approved(source)));
    assert.deepEqual(args.titles, ['CEO', 'DG']);
    assert.deepEqual(args.companies, ['Magileads', 'Darty']);
    assert.deepEqual(args.locations, ['France', 'Belgique']);
    if (source === 'linkedin') {
      assert.equal(args.title, '"CEO" OR "DG"');
      assert.equal(args.company, '"Magileads" OR "Darty"');
    }
  }
  assert.deepEqual(linkedinValues([], 'Injected fallback'), []);
  assert.deepEqual(linkedinValues(undefined, 'CEO'), ['CEO']);
  assert.equal(linkedinValues(['CEO', 1], ''), null);
  assert.equal(linkedinBooleanOr(['Research AND Development', 'CEO']), '"Research AND Development" OR "CEO"');
});

async function fixture(t, dropValue = false) {
  const previous = global.fetch;
  t.after(() => { global.fetch = previous; });
  const generated = [], extracted = [];
  global.fetch = async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer fixture-account');
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body ?? '{}');
    if (path === '/integrations/linkedin') return Response.json({ linkedin_accounts_list: [{ id: 7, is_valid: true, is_sales_navigator_account: true, checkpoint_required: false }] });
    if (path === '/contact-lists/42') return Response.json({ contact_list_profile: { id: 42, name: 'Existing' } });
    if (path === '/targeting/linkedin/locations/search') return Response.json({ locations: [{ id: body.name === 'France' ? 105015875 : 100565514, name_fr: body.name }] });
    if (path === '/targeting/linkedin/generate-peoples-search-url') {
      generated.push(body);
      const result = new URL('https://www.linkedin.com/search/results/people/');
      result.searchParams.set('titleFreeText', dropValue ? 'CEO' : body.current_title ?? '');
      result.searchParams.set('company', body.current_company ?? '');
      result.searchParams.set('geoUrn', JSON.stringify(body.locations));
      return Response.json({ linkedin_url: result.toString() });
    }
    if (path === '/targeting/linkedin/generate-sales-navigator-peoples-search-url') {
      generated.push(body);
      return Response.json({ linkedin_url: `https://www.linkedin.com/sales/search/people?criteria=${encodeURIComponent(JSON.stringify(body))}` });
    }
    if (/\/extract-(peoples-search|sales-navigator-peoples-search)$/.test(path)) { extracted.push({ path, body }); return Response.json({ contact_list_id: 42 }); }
    throw Error('Unexpected ' + path);
  };
  return { generated, extracted };
}

for (const source of ['linkedin', 'sales_navigator']) test(`${source}: CEO/DG and Magileads/Darty survive up to a single extraction`, async t => {
  const { generated, extracted } = await fixture(t);
  const tool = source === 'linkedin' ? 'run_linkedin_targeting' : 'run_sales_navigator_targeting';
  const args = approvedToolArgs(tool, '{}', approved(source));
  const result = JSON.parse(await executeTool(tool, args, auth, { profile: { permissions: [{ name: 'accessSearchAI', value: true }] } }));
  assert.equal(result.status, 'extraction lancée');
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].body.contact_list_id, 42);
  assert.equal(extracted[0].body.contact_list_name, null);
  if (source === 'linkedin') {
    assert.equal(generated[0].current_title, '"CEO" OR "DG"');
    assert.equal(generated[0].current_company, '"Magileads" OR "Darty"');
    assert.deepEqual(generated[0].locations, [105015875, 100565514]);
    const url = new URL(extracted[0].body.linkedin_people_search_url);
    assert.equal(url.searchParams.get('titleFreeText'), '"CEO" OR "DG"');
    assert.equal(url.searchParams.get('company'), '"Magileads" OR "Darty"');
    assert.deepEqual(result.criteria_applied.titles, ['CEO', 'DG']);
    assert.deepEqual(result.criteria_applied.companies, ['Magileads', 'Darty']);
  } else {
    assert.deepEqual(generated[0].current_titles, ['CEO', 'DG']);
    assert.deepEqual(generated[0].current_companies, ['Magileads', 'Darty']);
  }
});

test('a generator dropping a confirmed role cannot launch a smaller target silently', async t => {
  const { extracted } = await fixture(t, true);
  const result = JSON.parse(await executeTool('run_linkedin_targeting', approvedToolArgs('run_linkedin_targeting', '{}', approved('linkedin')), auth));
  assert.equal(result.stage, 'search_url_generation');
  assert.ok(result.error);
  assert.equal(extracted.length, 0);
});
