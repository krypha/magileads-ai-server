import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_TOOLS, TOOL_LABELS, executeTool } from './tools.js';
import { cardsForTool } from './cards.js';
import { IncludedWorkload } from './request-policy.js';

test('campaign reads stay in text; an explicit selection produces the picker', () => {
  const result = JSON.stringify({ total: 1, campaigns: [{ id: 12, workflow_id: 34, name: 'Relance' }] });
  assert.deepEqual(cardsForTool('list_campaigns', result), []);
  assert.deepEqual(cardsForTool('ask_campaign', result), [{
    kind: 'campaigns',
    purpose: 'selection',
    total: 1,
    items: [{ id: 12, workflow_id: 34, name: 'Relance' }],
  }]);
  assert.ok(AI_TOOLS.some(tool => tool.function.name === 'ask_campaign'));
  assert.equal(TOOL_LABELS.ask_campaign, 'Choix de campagne');
});

test('campaign picker and normal read use the same account data', async () => {
  const previous = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, '/statistics/programmations');
    assert.equal(options.headers.Authorization, 'Bearer account-token');
    return Response.json({ state: true, number_results: 1, programmations: [{ id: 12, workflow_id: 34, workflow_name: 'Relance', contacted: 20 }] });
  };
  try {
    const auth = { accessToken: 'account-token' };
    const read = await executeTool('list_campaigns', '{}', auth);
    const choice = await executeTool('ask_campaign', '{}', auth);
    assert.deepEqual(JSON.parse(choice), JSON.parse(read));
    assert.deepEqual(cardsForTool('list_campaigns', read), []);
    assert.equal(cardsForTool('ask_campaign', choice)[0]?.purpose, 'selection');
    const workload = new IncludedWorkload();
    workload.observe('ask_campaign', choice);
    assert.equal(workload.check('get_campaign', '{"workflow_id":34}'), null);
    assert.deepEqual([...workload.campaigns], ['campaign:12']);
  } finally {
    global.fetch = previous;
  }
});
