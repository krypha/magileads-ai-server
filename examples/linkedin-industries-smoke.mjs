/** Live language check only: no Magileads API request, no list or extraction. */
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../src/prompt.js';
import { AI_TOOLS, executeTool } from '../src/tools.js';
import { resolveLinkedinIndustry } from '../src/linkedin-industries.js';
import { upstreamRequest, readModelStream } from '../src/model-providers.js';

const key = process.env.AI_API_KEY || process.env.AI_INCLUDED_API_KEY;
if (!key) throw Error('AI_API_KEY required; never put the key in this script.');
const model = process.env.SMOKE_MODEL || 'deepseek/deepseek-v4-flash';
const tools = AI_TOOLS.filter(tool => ['update_targeting', 'search_linkedin_industries'].includes(tool.function.name));
const system = buildSystemPrompt({ first_name: 'QA', permissions: [{ name: 'accessSearchAI', value: true }] }, { mode: 'import', formBasedImport: true });
async function ask(question) {
  const context = {}, events = [];
  const messages = [{ role: 'system', content: system }, { role: 'user', content: question }];
  let text = '';
  for (let round = 0; round < 8; round++) {
    const request = upstreamRequest('openrouter', key, model, messages, AbortSignal.timeout(45000), {
      tools, toolChoice: round ? 'auto' : { type: 'function', function: { name: 'update_targeting' } }, maxTokens: 2200, disableReasoning: true,
    });
    const response = await fetch(request.url, request.options);
    assert.equal(response.status, 200, 'model request failed');
    const answer = await readModelStream(response.body, () => {}, 'openrouter');
    text += answer.assistantContent;
    if (!answer.calls.length) return { text, events, targeting: context.targeting };
    messages.push({ role: 'assistant', content: answer.assistantContent || null,
      tool_calls: answer.calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.args } })) });
    for (const call of answer.calls) {
      assert.ok(tools.some(tool => tool.function.name === call.name), 'only local read tools are allowed');
      const result = await executeTool(call.name, call.args, {}, context);
      events.push({ tool: call.name, args: JSON.parse(call.args) });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
  throw Error('too many model rounds');
}
const clear = await ask('Sur Sales Navigator, prépare une liste de CEO dans le secteur des éditeurs de logiciels SaaS. Pas de recherche à lancer.');
assert.ok(clear.events.some(event => event.tool === 'search_linkedin_industries'));
assert.ok(clear.targeting.sectors.some(value => resolveLinkedinIndustry(value)?.id === '4'));
console.log(JSON.stringify({ scenario: 'SaaS', ...clear }));
const ambiguous = await ask('Sur Sales Navigator, je veux des CEO dans la santé. Je ne sais pas quel secteur LinkedIn choisir : hôpitaux, pharmacies ou autres services de santé. Aide-moi à choisir.');
assert.ok(ambiguous.events.some(event => event.tool === 'search_linkedin_industries'));
assert.match(ambiguous.text, /\?/);
assert.match(ambiguous.text, /h[ôo]pit|pharmac|santé/i);
assert.ok(!ambiguous.targeting.sectors.length || ambiguous.targeting.ready_to_launch === false, 'do not resolve the user ambiguity without their choice');
console.log(JSON.stringify({ scenario: 'ambiguous_health', ...ambiguous }));
console.log('LIVE_INDUSTRY_CHECK_PASSED: no extraction or list creation');
