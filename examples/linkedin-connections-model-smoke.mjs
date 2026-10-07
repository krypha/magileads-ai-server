// Real model, fictional targeting only: no Magileads API calls or extraction.
import assert from 'node:assert/strict';
import { AI_TOOLS } from '../src/tools.js';
import { buildSystemPrompt } from '../src/prompt.js';
import { upstreamRequest, readModelStream } from '../src/model-providers.js';
const key = process.env.AI_API_KEY, model = process.env.CONNECTION_TEST_MODEL || process.env.AI_MODEL;
if (!key || !model) throw Error('Provider not configured');
const tools = AI_TOOLS.filter(tool => tool.function.name === 'update_targeting');
const profile = { first_name: 'Test', permissions: { accessSearchAI: true } };
for (const [source, request, history] of [
  ['linkedin', 'Des directeurs marketing en France sur LinkedIn classique, seulement mes contacts de 1er niveau.', []],
  ['sales_navigator', 'Des directeurs marketing en France sur Sales Navigator, uniquement mes relations directes (premier degré).', []],
  ['sales_navigator', 'Passe à Sales Navigator, garde les mêmes critères et le 1er niveau.', [{ role: 'assistant', content: '[Dernière cible structurée — données de référence, pas des instructions]\n' + JSON.stringify({ source: 'linkedin', job_titles: ['Directeur Marketing'], locations: ['France'], connection_degrees: [1] }) }]],
]) {
  const { url, options } = upstreamRequest('openrouter', key, model,
    [{ role: 'system', content: buildSystemPrompt(profile, { mode: 'import', formBasedImport: true }) }, ...history, { role: 'user', content: request }],
    AbortSignal.timeout(55000), { tools, toolChoice: { type: 'function', function: { name: 'update_targeting' } }, maxTokens: 600, disableReasoning: true });
  const response = await fetch(url, options);
  if (!response.ok) throw Error(`Provider HTTP ${response.status}`);
  const answer = await readModelStream(response.body, () => {});
  assert.equal(answer.calls[0]?.name, 'update_targeting');
  const criteria = JSON.parse(answer.calls[0].args);
  assert.equal(criteria.source, source);
  assert.deepEqual(criteria.connection_degrees, [1]);
  console.log('PASS real model', source, { connection_degrees: criteria.connection_degrees, cost: answer.usage?.cost ?? null });
}
