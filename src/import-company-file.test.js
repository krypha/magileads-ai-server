import assert from 'node:assert/strict';
import test from 'node:test';
import { approvedToolArgs, parseImportApproval } from './import-approval.js';
import { runSalesNavigator } from './import-targeting.js';

const names = ['L’Oréal (France), SAS', ...Array.from({ length: 100 }, (_, i) => 'Entreprise ' + (i + 2))];
const submission = {
  list_name: 'Liste unique',
  linkedin_account_id: 7,
  targeting: { source: 'sales_navigator', job_titles: ['CEO'], max_results: 7499 },
  company_file: { name: 'Entreprises.xlsx', companies: names },
};
const profile = { permissions: [{ name: 'accessSearchAI', value: true }] };
const auth = { apiKey: 'fixture-only' };

test('a file approval preserves all names outside the model criteria and rejects invalid batches', () => {
  const approval = parseImportApproval(submission);
  assert.deepEqual(approval.companyBatches.map(batch => batch.length), [50, 50, 1]);
  assert.deepEqual(approval.companyBatches.flat(), names);
  assert.equal(approval.criteria.companies.length, 6);
  assert.equal(approval.criteria.max_results, 7499);
  assert.ok(parseImportApproval({ ...submission, targeting: { ...submission.targeting, max_results: 7500 } }));
  assert.equal(parseImportApproval({ ...submission, targeting: { ...submission.targeting, max_results: 7501 } }), null);
  assert.equal(parseImportApproval({ ...submission, targeting: { ...submission.targeting, max_results: 2 } }), null);
  assert.equal(parseImportApproval({ ...submission, targeting: { ...submission.targeting, source: 'linkedin' } }), null);
  assert.equal(parseImportApproval({ ...submission, company_file: { companies: Array(501).fill('Example') } }), null);
  assert.equal(parseImportApproval({ ...submission, company_file: { companies: ['   '] } }), null);
  assert.deepEqual(parseImportApproval({ ...submission, targeting: { ...submission.targeting, max_results: 2500 }, company_file: { companies: ['Example', ' example '] } }).companyBatches, [['example']]);
});

function salesFixture(t, { dropCompany = false, failSecond = false, existing = false } = {}) {
  const previous = global.fetch;
  t.after(() => { global.fetch = previous; });
  const generations = [], extractions = [];
  global.fetch = async (raw, options) => {
    const path = new URL(raw).pathname;
    if (path === '/integrations/linkedin') return Response.json({ linkedin_accounts_list: [
      { id: 7, is_valid: true, is_sales_navigator_account: true, checkpoint_required: false },
    ] });
    if (path === '/contact-lists/42' && existing) return Response.json({ contact_list_profile: { id: 42, name: 'Liste existante' } });
    const body = JSON.parse(options.body);
    if (path.endsWith('/generate-sales-navigator-peoples-search-url')) {
      generations.push(body);
      const companies = dropCompany && generations.length === 3 ? body.current_companies.slice(1) : body.current_companies;
      const values = companies.map(name => '(text:' + encodeURIComponent(name).replace(/[()]/g, char => char === '(' ? '%28' : '%29') + ',selectionType:INCLUDED)');
      const query = '(filters:List((type:CURRENT_COMPANY,values:List(' + values.join(',') + ')),(type:CURRENT_TITLE,values:List((text:CEO,selectionType:INCLUDED)))))';
      return Response.json({ linkedin_url: 'https://www.linkedin.com/sales/search/people?' + new URLSearchParams({ query }) });
    }
    if (path.endsWith('/extract-sales-navigator-peoples-search')) {
      assert.equal(generations.length, 3);
      extractions.push(body);
      return Response.json(failSecond && extractions.length === 2 ? { state: false, state_message: 'fixture_failure' } : { contact_list_id: 42 });
    }
    throw Error('Unexpected endpoint: ' + path);
  };
  return { generations, extractions };
}

for (const existing of [false, true]) test('three confirmed company batches share the destination and total contact cap (existing=' + existing + ')', async t => {
  const { generations, extractions } = salesFixture(t, { existing });
  const approval = parseImportApproval(existing ? { ...submission, list_name: undefined, contact_list_id: 42 } : submission);
  const args = JSON.parse(approvedToolArgs('run_sales_navigator_targeting', '{"companies":["Ignored"]}', approval));
  const result = await runSalesNavigator(args, auth, profile, approval.companyBatches);
  assert.deepEqual(generations.flatMap(body => body.current_companies), names);
  assert.ok(generations.every(body => body.current_titles[0] === 'CEO'));
  assert.deepEqual(extractions.map(body => body.contact_list_id), [existing ? 42 : null, 42, 42]);
  assert.deepEqual(extractions.map(body => body.contact_list_name), [existing ? null : 'Liste unique', null, null]);
  assert.deepEqual(extractions.map(body => body.max_results), [2500, 2500, 2499]);
  assert.equal(result.submitted, 3);
  assert.equal(result.list_id, 42);
});

test('if a later URL loses an enterprise, no extraction starts', async t => {
  const { extractions } = salesFixture(t, { dropCompany: true });
  const approval = parseImportApproval(submission);
  const args = JSON.parse(approvedToolArgs('run_sales_navigator_targeting', '{}', approval));
  const result = await runSalesNavigator(args, auth, profile, approval.companyBatches);
  assert.equal(result.stage, 'search_url_generation');
  assert.equal(extractions.length, 0);
});

test('a rejected second batch reports the first and stops without submitting the third', async t => {
  const { extractions } = salesFixture(t, { failSecond: true });
  const approval = parseImportApproval(submission);
  const args = JSON.parse(approvedToolArgs('run_sales_navigator_targeting', '{}', approval));
  const result = await runSalesNavigator(args, auth, profile, approval.companyBatches);
  assert.equal(extractions.length, 2);
  assert.deepEqual(result, { list_id: 42, list_name: 'Liste unique', submitted: 1, total: 3, attempted: true });
});
