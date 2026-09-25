import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedRunTool, approvedToolArgs, parseImportApproval } from './import-approval.js';

test('reviewed Google Maps criteria and maximum override model-generated launch arguments', () => {
  const approval = parseImportApproval({
    list_name: 'Artisans Bordeaux',
    targeting: { source: 'google_maps', activity: 'plombiers', cities: ['Bordeaux'], max_results: 37 },
  });
  assert.ok(approval);
  assert.equal(approvedRunTool(approval), 'run_google_maps_targeting');
  const args = JSON.parse(approvedToolArgs('run_google_maps_targeting', JSON.stringify({
    search: 'dentistes', locations: ['Lyon'], max_results: 200, list_name: 'Nom inventé',
  }), approval));
  assert.deepEqual({ search: args.search, locations: args.locations, max_results: args.max_results, list_name: args.list_name },
    { search: 'plombiers', locations: ['Bordeaux'], max_results: 37, list_name: 'Artisans Bordeaux' });
  assert.equal(approvedToolArgs('run_linkedin_targeting', '{}', approval), null);
  assert.equal(parseImportApproval({ list_name: 'x', targeting: { source: 'google_maps', activity: 'x', cities: ['Paris'], max_results: 201 } }), null);
});

test('database extraction receives the same filters as the preview and a chosen existing list', () => {
  const filters = [{ field: 'job_title', contains: ['CEO'] }];
  const approval = parseImportApproval({
    contact_list_id: 42,
    targeting: { source: 'database', job_titles: ['CEO'], max_results: 75 },
    filters,
  });
  assert.ok(approval);
  const args = JSON.parse(approvedToolArgs('run_database_targeting', JSON.stringify({
    list_name: 'Wrong', filters: [{ field: 'company', contains: ['Other'] }], max_results: 10000,
  }), approval));
  assert.equal(args.contact_list_id, 42);
  assert.equal(args.list_name, undefined);
  assert.equal(args.max_results, 75);
  assert.deepEqual(args.filters, filters);
  assert.equal(parseImportApproval({ contact_list_id: 42,
    targeting: { source: 'database', job_titles: ['CEO'] }, filters: [{ field: 'job_title', bad_operator: ['CEO'] }] }), null);
});

test('reviewed LinkedIn account is enforced and incomplete criteria are refused', () => {
  const approval = parseImportApproval({ list_name: 'Direction France', linkedin_account_id: 7,
    targeting: { source: 'linkedin', job_titles: ['Directeur'], locations: ['France'], max_results: 50 } });
  assert.ok(approval);
  const args = JSON.parse(approvedToolArgs('run_linkedin_targeting', JSON.stringify({
    linkedin_account_id: 99, title: 'Assistant', location: 'Paris', list_name: 'Wrong',
  }), approval));
  assert.equal(args.linkedin_account_id, 7);
  assert.equal(args.title, 'Directeur');
  assert.equal(args.location, 'France');
  assert.equal(parseImportApproval({ list_name: 'x', linkedin_account_id: 7,
    targeting: { source: 'linkedin', locations: ['France'] } }), null);
});
