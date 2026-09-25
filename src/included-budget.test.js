import test from 'node:test';
import assert from 'node:assert/strict';
import { checkIncludedBudget, paidBudgetAvailable, sharedPromptTooLarge } from './included-budget.js';

test('only a verified daily key capped at three dollars unlocks paid included AI', () => {
  const status = { data: { limit: 3, limit_reset: 'daily', limit_remaining: 0.25 } };
  assert.equal(paidBudgetAvailable(status), true);
  assert.equal(paidBudgetAvailable({ data: { ...status.data, limit_remaining: 0 } }), false);
  assert.equal(paidBudgetAvailable({ data: { ...status.data, limit_reset: 'monthly' } }), false);
  assert.equal(paidBudgetAvailable({ data: { ...status.data, limit: 4 } }), false);
  assert.equal(paidBudgetAvailable({ data: { ...status.data, disabled: true } }), false);
});

test('budget check fails closed, with no local usage records', async () => {
  assert.equal(await checkIncludedBudget('test-key', async () => Response.json({ data: {
    limit: 3, limit_reset: 'daily', limit_remaining: 1.5,
  } })), true);
  assert.equal(await checkIncludedBudget('test-key', async () => Response.json({}, { status: 503 })), false);
  assert.equal(await checkIncludedBudget('test-key', async () => { throw Error('offline'); }), false);
});

test('heavy included prompts are rejected before a paid model call', () => {
  assert.equal(sharedPromptTooLarge([{ role: 'user', content: 'a'.repeat(4000) }]), false);
  assert.equal(sharedPromptTooLarge([{ role: 'user', content: 'a'.repeat(4001) }]), true);
  assert.equal(sharedPromptTooLarge(Array.from({ length: 7 }, () => ({ role: 'assistant', content: 'a'.repeat(4000) }))), true);
});
