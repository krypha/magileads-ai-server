// Real provider, fictional Magileads fixtures only. No customer API call.
import { API_BASE } from '../src/magileads.js';
import { AI_TOOLS, executeTool } from '../src/tools.js';
import { cardsForTool } from '../src/cards.js';
import { buildSystemPrompt } from '../src/prompt.js';
import { upstreamRequest, readModelStream } from '../src/model-providers.js';

const key = process.env.AI_API_KEY, model = process.env.COPY_TEST_MODEL || process.env.AI_MODEL;
if (!key || !model) throw Error('AI_API_KEY and AI_MODEL are required');
const names = new Set(['list_contact_lists', 'ask_contact_list', 'get_contact_list', 'list_contact_fields', 'preview_contact_selection', 'query_contacts',
  'copy_contacts_to_list', 'discover_operations', 'run_operation']);
const tools = AI_TOOLS.filter(tool => names.has(tool.function.name));
const profile = { id: 1, first_name: 'Test', level: 'admin' };
const originalFetch = global.fetch, copies = [], unexpected = [];
const lists = new Map([[69964, { id: 69964, name: 'DAF Paris', number_of_contacts: 36 }], [777, { id: 777, name: 'Destination', number_of_contacts: 20 }]]);
global.fetch = async (url, options = {}) => {
  const parsed = new URL(url), path = parsed.pathname;
  if (parsed.origin !== new URL(API_BASE).origin) return originalFetch(url, options);
  const body = options.body ? JSON.parse(options.body) : null;
  if (options.method === 'GET') {
    if (path === '/data-fields') return Response.json({ state: true, data_fields_list: [{ id: 2, name: 'Civilité', identifier: 'civility', possible_values: ['Monsieur', 'Madame'] }] });
    if (path === '/contact-lists/names') return Response.json({ state: true, contact_lists: [...lists.values()] });
    const listId = Number(path.match(/^\/contact-lists\/(\d+)$/)?.[1]);
    if (lists.has(listId)) return Response.json({ state: true, contact_list_profile: lists.get(listId) });
    if (path === '/contact-lists/69964/contacts') {
      const condition = JSON.parse(parsed.searchParams.get('options') || '{}').filter?.values?.[0];
      const count = !condition ? 36 : condition.field_name === '2' && condition.type === 'equals' && condition.value === 'Monsieur' ? 16 : 0;
      return Response.json({ state: true, number_of_results: count, results: count ? [{ id: 100, properties: [{ data_field_id: 2, value: 'Monsieur' }] }] : [] });
    }
  }
  if (options.method === 'POST' && path === '/contact-lists/69964/copy') {
    copies.push(body);
    const target = body.contact_list_id_destination ?? 888;
    if (!lists.has(target)) lists.set(target, { id: target, name: 'Copie de DAF Paris', number_of_contacts: 0 });
    return Response.json({ state: true, contact_list_id: target });
  }
  if (options.method === 'PUT' && path === '/contact-lists/888') {
    lists.get(888).name = body.name;
    return Response.json({ state: true });
  }
  if (options.method !== 'GET') unexpected.push({ path, method: options.method });
  return Response.json({ state: false, state_message: 'fictional_fixture_unavailable' }, { status: 403 });
};
async function call(messages, selectedTools, options = {}) {
  const request = upstreamRequest('openrouter', key, model, messages, AbortSignal.timeout(50_000), {
    tools: selectedTools, maxTokens: 2_000, disableReasoning: model !== 'openrouter/free' && !model.endsWith(':free'), ...options,
  });
  const response = await fetch(request.url, request.options);
  if (!response.ok) throw Error(`Provider HTTP ${response.status}`);
  return readModelStream(response.body, () => {});
}
async function run(messages, pageContext = false) {
  const conversation = [{ role: 'system', content: buildSystemPrompt(profile, { pageContext }) }, ...messages];
  const context = { profile, copyAttempts: new Set() }, results = [], cards = [], toolNames = [];
  let cost = 0;
  for (let round = 0; round < 6; round++) {
    const answer = await call(conversation, tools);
    cost += answer.usage?.cost ?? 0;
    if (!answer.calls.length) return { text: answer.assistantContent, cost, results, cards, toolNames };
    conversation.push({ role: 'assistant', content: answer.assistantContent || null,
      tool_calls: answer.calls.map(tool => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.args } })) });
    for (const tool of answer.calls) {
      const content = await executeTool(tool.name, tool.args, { accessToken: 'fictional-fixture-only' }, context);
      results.push(JSON.parse(content));
      cards.push(...cardsForTool(tool.name, content, tool.args));
      toolNames.push(tool.name);
      conversation.push({ role: 'tool', tool_call_id: tool.id, content });
    }
  }
  throw Error('model_did_not_finish');
}
try {
  const first = { role: 'user', content: 'T’as moyen de filtrer tous les monsieurs sur ma liste "DAF PARIS" et de me les copier vers une autre liste ?' };
  const ambiguous = await run([first]);
  const beforeChoice = copies.length;
  const named = await run([first, { role: 'assistant', content: ambiguous.text }, { role: 'user', content: 'Crée une nouvelle liste « DAF Paris — Messieurs » et copie le segment dedans.' }]);
  const existing = await run([{ role: 'user', content: 'Copie tous les contacts de civilité Monsieur de DAF PARIS vers ma liste Destination #777.' }]);
  const beforeNormal = copies.length;
  const normal = await run([{ role: 'user', content: 'Combien de contacts ont la civilité Monsieur dans DAF PARIS ?' }]);
  const selection = await run([{ role: 'user', content: 'Affiche mes listes avec leurs ID pour que je puisse sélectionner une liste.' }]);
  const ranking = await run([{ role: 'user', content: 'Affiche dans un tableau mes deux plus grandes listes avec leur nombre de contacts.' }]);
  const valid = (result, listId) => result.results.some(item => item.operation === 'copy_contacts_to_list' && item.status === 'accepted' && item.list_id === listId && item.matched_contacts === 16);
  const allFiltered = copies.every(body => JSON.stringify(body.contacts_selection.filter) === JSON.stringify({ mode: 'and', values: [{ field_name: '2', type: 'equals', value: 'Monsieur' }] }) && body.contacts_selection.contact_ids.length === 0);
  const visibleListCards = result => result.cards.filter(card => card.kind === 'lists' && card.purpose === 'selection');
  const listPresentation = [named, existing, normal, ranking].every(result => !visibleListCards(result).length) &&
    visibleListCards(selection).length === 1 && selection.toolNames.includes('ask_contact_list') &&
    ranking.toolNames.includes('list_contact_lists') && ranking.text.includes('|');
  const ok = beforeChoice === 0 && valid(named, 888) && valid(existing, 777) && copies.length === beforeNormal && copies.length === 2 && allFiltered && unexpected.length === 0 &&
    listPresentation && lists.get(888).name === 'DAF Paris — Messieurs' && ![ambiguous, named, existing, normal].some(result => result.text.includes('[[ACTION]]'));
  console.log(JSON.stringify({ model, ok, beforeChoice, namedCopy: valid(named, 888), existingCopy: valid(existing, 777), fictionalCopies: copies.length,
    allFiltered, listPresentation, unexpectedWrites: unexpected.length, customerApiCalls: 0, cost: [ambiguous, named, existing, normal, selection, ranking].reduce((total, result) => total + result.cost, 0) }));
  if (!ok) {
    if (process.env.COPY_TEST_DEBUG === '1') console.log(JSON.stringify({ ambiguous, named, existing, normal, selection, ranking, copies, unexpected }));
    process.exitCode = 1;
  }
} finally { global.fetch = originalFetch; }
