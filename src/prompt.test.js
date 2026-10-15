import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from './prompt.js';
import { OPERATIONS } from './operations.js';

test('the prompt gives today\'s date in Paris time, for relative periods', () => {
  // 22:30 UTC on the 15th is already the 16th in Paris.
  const prompt = buildSystemPrompt({ first_name: 'Iris' }, { now: new Date('2026-10-15T22:30:00Z') });
  assert.match(prompt, /Nous sommes le vendredi 2026-10-16 \(heure de Paris\)/);
});

test('report operations document the period the API wants', () => {
  for (const name of ['get_period_reporting', 'get_daily_reporting']) {
    const op = OPERATIONS.find(item => item.name === name);
    assert.match(op.description, /"start_date":"AAAA-MM-JJ","end_date":"AAAA-MM-JJ"/);
  }
  assert.match(OPERATIONS.find(op => op.name === 'create_email_model').description, /subject, html .* ET text/);
});
