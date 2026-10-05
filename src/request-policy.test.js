import test from 'node:test';
import assert from 'node:assert/strict';
import { IncludedWorkload } from './request-policy.js';
import { buildSystemPrompt } from './prompt.js';

test('every assistant mode and provider permits general questions without a topic restriction', () => {
  for (const mode of ['chat', 'import']) for (const personalKey of [false, true]) for (const pageContext of [false, true]) {
    const prompt = buildSystemPrompt({ id: 391, level: 'user' }, { mode, personalKey, pageContext });
    assert.match(prompt, /réponds à toute demande de l’utilisateur, même hors Magileads/);
    assert.doesNotMatch(prompt, /PÉRIMÈTRE MAGIA|Refuse brièvement toute question indépendante/);
  }
});

test('included tools cannot audit a fourth campaign, including scenarios and reporting aliases', () => {
  const policy = new IncludedWorkload();
  policy.observe('list_campaigns', JSON.stringify({ campaigns: [1, 2, 3, 4].map(id => ({ id, workflow_id: id + 10 })) }));
  for (const id of [1, 2, 3]) {
    assert.equal(policy.check('get_campaign_statistics', JSON.stringify({ id })), null);
    assert.equal(policy.check('get_campaign', JSON.stringify({ workflow_id: id + 10 })), null);
  }
  assert.equal(policy.check('get_campaign', '{"workflow_id":14}'), 'request_too_broad');
  assert.equal(policy.check('run_operation', JSON.stringify({ operation: 'get_daily_reporting', body: {} })), 'request_too_broad');
  assert.equal(policy.check('run_operation', JSON.stringify({ operation: 'get_period_reporting', body: { limit_to_programmation_ids: [1, 2, 3, 4] } })), 'request_too_broad');
});

test('included tool count is bounded across rounds even on the free model', () => {
  const policy = new IncludedWorkload();
  for (let n = 0; n < 12; n++) assert.equal(policy.check('discover_operations', '{}'), null);
  assert.equal(policy.check('discover_operations', '{}'), 'request_too_broad');
});
