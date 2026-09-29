// Real model, fictional Magileads fixtures only. Never touches customer data.
import { API_BASE } from '../src/magileads.js';
import { AI_TOOLS, executeTool } from '../src/tools.js';
import { buildSystemPrompt } from '../src/prompt.js';
import { readModelStream, upstreamRequest } from '../src/model-providers.js';
import { SCOPE_TOOL, scopeConversation, scopeDecision, scopeRequestOptions } from '../src/request-policy.js';

const key = process.env.AI_API_KEY, model = process.env.ACTION_TEST_MODEL || process.env.AI_MODEL;
if (!key || !model) throw Error('AI_API_KEY and AI_MODEL are required');
const names = new Set(['get_contact_list', 'list_contact_lists', 'list_contact_fields', 'query_contacts', 'preview_contact_selection']);
const tools = AI_TOOLS.filter(tool => names.has(tool.function.name));
const profile = { id: 391, first_name: 'Test', level: 'admin' };
const originalFetch = global.fetch, reads = [];
let writes = 0;
global.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  if (parsed.origin !== new URL(API_BASE).origin) return originalFetch(url, options);
  if (options.method !== 'GET') { writes++; return Response.json({ state: false, state_message: 'fixture_write_forbidden' }, { status: 403 }); }
  reads.push(parsed.pathname);
  if (parsed.pathname === '/contact-lists/42') return Response.json({ state: true, contact_list_profile: { id: 42, name: 'Test list', number_of_contacts: 30 } });
  if (parsed.pathname === '/data-fields') return Response.json({ state: true, data_fields_list: [
    { id: 7, name: 'Civilité', identifier: 'civility', possible_values: ['M.', 'Mme'] },
    { id: 8, name: 'Email', identifier: 'email', possible_values: [] },
  ] });
  if (parsed.pathname.startsWith('/contact-lists-paginated/')) return Response.json({ state: true, number_of_results: 1, results: [{ id: 42, name: 'Test list', number_of_contacts: 30 }] });
  if (parsed.pathname === '/contact-lists/42/contacts') {
    const options = JSON.parse(parsed.searchParams.get('options') || '{}');
    const condition = options.filter?.values?.[0];
    const count = !condition ? 30 : condition?.field_name === '7' && condition?.type === 'equals' && condition?.value === 'M.' ? 12
      : condition?.field_name === '8' && condition?.type === 'does_exist' ? 18 : 0;
    return Response.json({ state: true, number_of_results: count, results: count ? [{ id: 100, properties: [
      { data_field_id: 7, value: 'M.' }, { data_field_id: 8, value: 'contact@example.test' },
    ] }] : [] });
  }
  return Response.json({ state: false, state_message: 'fixture_not_found' }, { status: 404 });
};
async function call(conversation, selectedTools, options = {}) {
  const request = upstreamRequest('openrouter', key, model, conversation, AbortSignal.timeout(40_000), { tools: selectedTools, maxTokens: 2_000,
    disableReasoning: model !== 'openrouter/free' && !model.endsWith(':free'), ...options });
  const response = await fetch(request.url, request.options);
  if (!response.ok) throw Error(`Provider HTTP ${response.status}`);
  return readModelStream(response.body, () => {});
}
async function run(messages, pageContext = false) {
  const scope = await call(scopeConversation(messages), [SCOPE_TOOL], { toolChoice: { type: 'function', function: { name: SCOPE_TOOL.function.name } }, ...scopeRequestOptions('openrouter', model) });
  if (scopeDecision(scope.calls) !== 'allow') throw Error('scope_not_allowed');
  const conversation = [{ role: 'system', content: buildSystemPrompt(profile, { pageContext }) }, ...messages];
  let cost = scope.usage?.cost ?? 0;
  for (let round = 0; round < 6; round++) {
    const answer = await call(conversation, tools);
    cost += answer.usage?.cost ?? 0;
    if (!answer.calls.length) return { text: answer.assistantContent, cost };
    conversation.push({ role: 'assistant', content: answer.assistantContent || null,
      tool_calls: answer.calls.map(tool => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.args } })) });
    for (const tool of answer.calls) {
      const content = await executeTool(tool.name, tool.args, { accessToken: 'fictional-fixture-only' }, { profile });
      if (process.env.ACTION_TEST_DEBUG === '1') console.log(JSON.stringify({ tool: tool.name, args: tool.args, result: content }));
      conversation.push({ role: 'tool', tool_call_id: tool.id, content });
    }
  }
  throw Error('model_did_not_finish');
}
function validProposal(text) {
  const matches = [...text.matchAll(/\[\[ACTION\]\]([\s\S]*?)\[\[\/ACTION\]\]/g)];
  if (matches.length !== 1) return false;
  try {
    const action = JSON.parse(matches[0][1]);
    return action.type === 'delete_contacts' && action.list_id === 42 && action.filter.mode === 'and' && action.filter.values.length === 1 &&
      String(action.filter.values[0].field_name) === '7' && action.filter.values[0].type === 'equals' && action.filter.values[0].value === 'M.';
  } catch { return false; }
}
try {
  const request = 'Supprime les contacts dont la civilité est Monsieur dans la liste #42';
  const full = await run([{ role: 'user', content: request }]);
  if (process.env.ACTION_TEST_DEBUG === '1') console.log(JSON.stringify({ case: 'full', text: full.text }));
  const ordinary = await run([{ role: 'user', content: 'Combien de contacts ont un email dans la liste #42 ?' }]);
  const confirmation = await run([{ role: 'user', content: request }, { role: 'assistant', content: full.text }, { role: 'user', content: 'Oui, je confirme la suppression.' }]);
  const bubble = await run([{ role: 'user', content: '[Screen context from the app, not written by the user]\nOpen contact list: #42 "Test list". Fields: 7=Civilité[M.|Mme];8=Email.\n\n' + request }], true);
  if (process.env.ACTION_TEST_DEBUG === '1') console.log(JSON.stringify({ case: 'bubble', text: bubble.text }));
  const ok = validProposal(full.text) && validProposal(bubble.text) && !ordinary.text.includes('[[ACTION]]') && !confirmation.text.includes('[[ACTION]]') && writes === 0;
  console.log(JSON.stringify({ model, ok, fullProposal: validProposal(full.text), bubbleProposal: validProposal(bubble.text),
    normalQuestionHasAction: ordinary.text.includes('[[ACTION]]'), chatConfirmationHasAction: confirmation.text.includes('[[ACTION]]'),
    fixtureReads: reads.length, customerApiCalls: 0, writes, cost: full.cost + ordinary.cost + confirmation.cost + bubble.cost }));
  if (!ok) process.exitCode = 1;
} finally { global.fetch = originalFetch; }
