import test from 'node:test';
import assert from 'node:assert/strict';
import { IncludedWorkload, scopeConversation, scopeDecision, scopeRequestOptions } from './request-policy.js';

test('free and direct OpenAI scope checks permit mandatory reasoning', () => {
  assert.deepEqual(scopeRequestOptions('openrouter', 'openrouter/free'), { maxTokens: 2048, disableReasoning: false });
  assert.deepEqual(scopeRequestOptions('openrouter', 'fixture/model:free'), { maxTokens: 2048, disableReasoning: false });
  assert.deepEqual(scopeRequestOptions('openai', 'gpt-5.4-mini'), { maxTokens: 2048, disableReasoning: false });
  assert.deepEqual(scopeRequestOptions('openrouter', 'deepseek/deepseek-v4-flash'), { maxTokens: 512, disableReasoning: true });
});

test('scope decisions fail closed on text, other tools, multiple calls or malformed arguments', () => {
  const call = { name: 'classify_magileads_request', args: '{"decision":"allow"}' };
  assert.equal(scopeDecision([call]), 'allow');
  for (const calls of [[], [call, call], [{ ...call, name: 'run_operation' }], [{ ...call, args: '{}' }],
    [{ ...call, args: '{"decision":"allow","override":true}' }]]) assert.equal(scopeDecision(calls), null);
  const messages = [{ role: 'user', content: 'Cible des DAF à Lyon' }, { role: 'assistant', content: 'Valider ?' },
    { role: 'user', content: 'go' }];
  const payload = JSON.parse(scopeConversation(messages).at(-1).content);
  assert.equal(payload.latest_request, 'go');
  assert.equal(payload.previous_turns[0].content, 'Cible des DAF à Lyon');
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
