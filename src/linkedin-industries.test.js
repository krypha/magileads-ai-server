import test from 'node:test';
import assert from 'node:assert/strict';
import { searchLinkedinIndustries, resolveLinkedinIndustry, resolveLinkedinIndustries, salesNavigatorIndustriesApplied } from './linkedin-industries.js';
import { normalizeTargeting, runSalesNavigator, ownConnectionsOnly } from './import-targeting.js';
import { parseImportApproval, approvedToolArgs } from './import-approval.js';
import { executeTool } from './tools.js';
import { changesData, cardsForTool } from './cards.js';

const auth = { accessToken: 'fixture-only' };
const profile = { permissions: [{ name: 'accessSearchAI', value: true }] };
const target = { source: 'sales_navigator', job_titles: ['CEO'], locations: ['France'], sectors: ['Développement de logiciels'], max_results: 50 };

test('catalog search discovers semantic candidates without inventing an automatic match', async () => {
  const previous = global.fetch;
  global.fetch = () => { throw Error('catalog lookup must not use the API'); };
  try {
    const raw = await executeTool('search_linkedin_industries', '{"query":"SaaS"}', auth);
    const result = JSON.parse(raw);
    assert.ok(result.industries.some(item => item.id === '4' && item.name_fr === 'Développement de logiciels'));
    assert.equal(result.match, undefined); // Discovery is not a definitive mapping.
    assert.equal(changesData('search_linkedin_industries', raw), false);
    assert.deepEqual(cardsForTool('search_linkedin_industries', raw), []);
    assert.ok(searchLinkedinIndustries('santé').industries.length > 1);
    assert.equal(resolveLinkedinIndustry('santé'), null);
    assert.equal(searchLinkedinIndustries('secteur complètement inexistant xyz').industries.length, 0);
    assert.ok(searchLinkedinIndustries('').industries.length > 400);
  } finally { global.fetch = previous; }
});

test('valid French/English labels and real IDs resolve, ambiguous or invented ones require a human choice', () => {
  for (const value of ['4', 'Développement de logiciels', 'Software Development']) assert.equal(resolveLinkedinIndustry(value).id, '4');
  assert.equal(resolveLinkedinIndustry('Recrutement').id, '104');
  const unresolved = resolveLinkedinIndustries(['santé', 'SaaS']);
  assert.equal(unresolved.requires_user_choice, true);
  assert.equal(unresolved.unresolved.length, 2);
  assert.ok(unresolved.unresolved[0].candidates.some(item => item.id === '14'));
  for (const field of ['sectors', 'sectors_exclude']) {
    const criteria = normalizeTargeting({ ...target, [field]: ['SaaS'] });
    assert.equal(criteria.ready_to_launch, false);
    assert.ok(criteria.missing.some(message => /secteur LinkedIn/.test(message)));
    assert.equal(parseImportApproval({ targeting: criteria, contact_list_id: 42, linkedin_account_id: 7 }), null);
  }
  assert.equal(normalizeTargeting({ ...target, source: 'database', sectors: ['SaaS'] }).ready_to_launch, true);
  assert.equal(ownConnectionsOnly({ source: 'linkedin', connection_degrees: [1], sectors: ['4'] }), false);
});

function facet(included = [], excluded = []) {
  const values = [...included.map(id => '(id:' + id + ',selectionType:INCLUDED)'), ...excluded.map(id => '(id:' + id + ',selectionType:EXCLUDED)')];
  return '(filters:List((type:INDUSTRY,values:List(' + values.join(',') + '))))';
}

test('URL verification checks exact industry IDs and distinguishes included from excluded', () => {
  const url = 'https://www.linkedin.com/sales/search/people?' + new URLSearchParams({ query: facet([4, 96], [104]) });
  assert.equal(salesNavigatorIndustriesApplied(url, [4, 96], [104]), true);
  assert.equal(salesNavigatorIndustriesApplied(url, [4, 104], []), false);
  assert.equal(salesNavigatorIndustriesApplied(url, [4], [96]), false);
  assert.equal(salesNavigatorIndustriesApplied(url, [41], []), false);
  assert.equal(salesNavigatorIndustriesApplied('https://www.linkedin.com/sales/search/people?random=4', [4], []), false);
});

async function fixture(t, { ignore = false, replace = false } = {}) {
  const previous = global.fetch, generated = [], extracted = [];
  t.after(() => { global.fetch = previous; });
  global.fetch = async (raw, options) => {
    const path = new URL(raw).pathname, body = JSON.parse(options.body ?? '{}');
    if (path === '/integrations/linkedin') return Response.json({ linkedin_accounts_list: [{ id: 7, is_valid: true, checkpoint_required: false, is_sales_navigator_account: true }] });
    if (path === '/contact-lists/42') return Response.json({ contact_list_profile: { id: 42, name: 'Existing' } });
    if (path === '/targeting/linkedin/locations/search') return Response.json({ locations: [{ id: 105015875, name_fr: 'France' }] });
    if (path.endsWith('/generate-sales-navigator-peoples-search-url')) {
      generated.push(body);
      const effective = { ...body };
      if (ignore) delete effective.industries;
      const url = new URL('https://www.linkedin.com/sales/search/people');
      url.searchParams.set('criteria', JSON.stringify(effective));
      if (effective.industries?.length || effective.industries_exclude?.length) url.searchParams.set('query', facet(replace ? [96] : effective.industries, effective.industries_exclude));
      return Response.json({ linkedin_url: url.toString() });
    }
    if (path.endsWith('/generate-peoples-search-url')) {
      generated.push(body);
      const url = new URL('https://www.linkedin.com/search/results/people/');
      url.searchParams.set('titleFreeText', body.current_title ?? '');
      if (!ignore) url.searchParams.set('industry', JSON.stringify(replace ? ['96'] : body.industries.map(String)));
      return Response.json({ linkedin_url: url.toString() });
    }
    if (/\/extract-(peoples-search|sales-navigator-peoples-search)$/.test(path)) { extracted.push(body); return Response.json({ contact_list_id: 42 }); }
    throw Error('unexpected API request ' + path);
  };
  return { generated, extracted };
}

for (const source of ['linkedin', 'sales_navigator']) {
  test(source + ': approved exact sector reaches one extraction, overriding model arguments', async t => {
    const { generated, extracted } = await fixture(t);
    const approval = parseImportApproval({ targeting: { ...target, source }, contact_list_id: 42, linkedin_account_id: 7 });
    const tool = source === 'linkedin' ? 'run_linkedin_targeting' : 'run_sales_navigator_targeting';
    const args = approvedToolArgs(tool, '{"industries":["96"]}', approval);
    const result = JSON.parse(await executeTool(tool, args, auth, { profile }));
    assert.equal(result.status, 'extraction lancée');
    assert.equal(extracted.length, 1);
    assert.ok(generated.some(body => body.industries?.includes(4)));
    assert.equal(String(result.criteria_applied.industries[0].id), '4');
  });
  for (const settings of [{ ignore: true }, { replace: true }]) test(source + ': absent or substituted sector cancels extraction ' + JSON.stringify(settings), async t => {
    const { extracted } = await fixture(t, settings);
    const tool = source === 'linkedin' ? 'run_linkedin_targeting' : 'run_sales_navigator_targeting';
    const result = JSON.parse(await executeTool(tool, JSON.stringify({ titles: ['CEO'], industries: ['4'], linkedin_account_id: 7, contact_list_id: 42 }), auth, { profile }));
    assert.ok(result.error);
    assert.equal(result.requires_user_choice, true);
    assert.equal(extracted.length, 0);
  });
}

test('an unresolved included OR excluded sector refuses before any API call, even with other usable criteria', async () => {
  const previous = global.fetch;
  global.fetch = () => { throw Error('an unresolved industry must not reach the API'); };
  try {
    for (const key of ['industries', 'industries_exclude']) {
      const result = await runSalesNavigator({ titles: ['CEO'], [key]: ['Secteur inconnu'], linkedin_account_id: 7, contact_list_id: 42 }, auth, profile);
      assert.equal(result.error_key, 'linkedin_industry_choice_required');
      assert.equal(result.requires_user_choice, true);
    }
    const result = JSON.parse(await executeTool('run_linkedin_targeting', JSON.stringify({ titles: ['CEO'], industries: ['SaaS'], linkedin_account_id: 7, contact_list_id: 42 }), auth));
    assert.equal(result.error_key, 'linkedin_industry_choice_required');
  } finally { global.fetch = previous; }
});
