import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTargeting, ownConnectionsOnly, OWN_CONNECTIONS_MAX } from './import-targeting.js';
import { parseImportApproval, approvedToolArgs } from './import-approval.js';
import { executeTool } from './tools.js';

test('LinkedIn first degree alone is a complete target: no title, company or place required', () => {
  const own = normalizeTargeting({ source: 'linkedin', connection_degrees: [1] });
  assert.equal(own.ready_to_launch, true);
  assert.deepEqual(own.missing, []);
  assert.equal(ownConnectionsOnly(own), true);
  // The whole network may exceed a search's 1,000.
  assert.equal(normalizeTargeting({ source: 'linkedin', connection_degrees: [1], max_results: 5000 }).ready_to_launch, true);
  assert.equal(normalizeTargeting({ source: 'linkedin', connection_degrees: [1], max_results: OWN_CONNECTIONS_MAX + 1 }).max_results, OWN_CONNECTIONS_MAX);

  // Narrowed by a title, it is still complete, but a search again (capped at 1,000).
  const narrowed = normalizeTargeting({ source: 'linkedin', connection_degrees: [1], job_titles: ['CEO'], max_results: 5000 });
  assert.equal(ownConnectionsOnly(narrowed), false);
  assert.equal(narrowed.ready_to_launch, false);

  // Second degree, or no degree, still needs the usual criteria.
  for (const degrees of [[2], [1, 2], []]) {
    const wide = normalizeTargeting({ source: 'linkedin', connection_degrees: degrees });
    assert.equal(wide.ready_to_launch, false, JSON.stringify(degrees));
  }
  // Sales Navigator keeps its own rule.
  assert.equal(normalizeTargeting({ source: 'sales_navigator', connection_degrees: [1] }).ready_to_launch, false);
});

test('the reviewed "my connections" target reaches the run tool without criteria', () => {
  const approval = parseImportApproval({ list_name: '1er niveau de connexion', linkedin_account_id: 7,
    targeting: { source: 'linkedin', connection_degrees: [1], max_results: 2500 } });
  assert.ok(approval);
  const args = JSON.parse(approvedToolArgs('run_linkedin_targeting', '{}', approval));
  assert.deepEqual(args.connection_degrees, [1]);
  assert.equal(args.title, '');
  assert.equal(args.location, '');
  assert.equal(args.max_results, 2500);
});

test('run_linkedin_targeting imports the whole first-degree network through extract-connections', async () => {
  const previous = global.fetch;
  const calls = [];
  global.fetch = async (raw, options = {}) => {
    const path = new URL(raw).pathname;
    calls.push(path);
    if (path === '/integrations/linkedin') return Response.json({ linkedin_accounts_list: [{ id: 7, is_valid: true }] });
    if (path === '/targeting/linkedin/extract-connections') {
      const body = JSON.parse(options.body);
      assert.equal(body.linkedin_account_id, 7);
      assert.equal(body.contact_list_name, '1er niveau de connexion');
      assert.equal(body.max_results, 2500);
      assert.equal(body.linkedin_people_search_url, undefined);
      return Response.json({ state: true, contact_list_id: 99 });
    }
    throw Error(`Unexpected ${path}`);
  };
  try {
    const result = JSON.parse(await executeTool('run_linkedin_targeting', JSON.stringify({
      linkedin_account_id: 7, list_name: '1er niveau de connexion', connection_degrees: [1], max_results: 2500,
      title: '', location: '', company: '',
    }), { apiKey: 'fixture' }, { profile: { permissions: {} } }));
    assert.equal(result.status, 'extraction lancée');
    assert.equal(result.list_id, 99);
    assert.equal(result.criteria_applied.connections_only, true);
    assert.ok(!calls.some(path => path.includes('/generate-')), 'no people-search URL is generated');
  } finally { global.fetch = previous; }
});
