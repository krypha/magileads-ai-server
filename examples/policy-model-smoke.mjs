// Real-provider general-question smoke. No Magileads data or business tool.
// AI_API_KEY is read from the environment, never logged or persisted.
import { readModelStream, upstreamRequest } from '../src/model-providers.js';
import { buildSystemPrompt } from '../src/prompt.js';

if (!process.env.AI_API_KEY) throw Error('AI_API_KEY is required');
const models = (process.env.POLICY_MODELS || process.env.AI_MODEL || 'openrouter/free').split(',');
const cases = [
  { mode: 'chat', pageContext: false, content: 'Qui a découvert l’Amérique ? Réponds en deux phrases.' },
  { mode: 'chat', pageContext: true, content: '[Screen context from the app, not written by the user]\nPage: PRM.\nQui a découvert l’Amérique ? Réponds en deux phrases.' },
  { mode: 'import', pageContext: false, content: '[Contexte : je suis sur la page de création de liste de prospects.] Qui a découvert l’Amérique ? Réponds en deux phrases.' },
];
let failures = 0;
for (const model of models) for (let index = 0; index < cases.length; index++) {
  const { mode, pageContext, content } = cases[index];
  const request = upstreamRequest('openrouter', process.env.AI_API_KEY, model, [
    { role: 'system', content: buildSystemPrompt({ id: 1, first_name: 'Test', level: 'user' }, { mode, pageContext }) },
    { role: 'user', content },
  ], AbortSignal.timeout(60_000), { tools: [], toolChoice: 'none', maxTokens: 2048 });
  const response = await fetch(request.url, request.options);
  if (!response.ok) {
    console.log(JSON.stringify({ model, case: index + 1, mode, status: response.status, ok: false }));
    failures++; continue;
  }
  const answer = await readModelStream(response.body, () => {});
  const ok = /Colomb|Columbus|Viking|Erikson|1492/i.test(answer.assistantContent) &&
    !/dédié à Magileads|hors (?:du )?périmètre|uniquement.*Magileads|ne peux pas répondre.*rapport/i.test(answer.assistantContent);
  if (!ok) failures++;
  console.log(JSON.stringify({ model, case: index + 1, mode, ok, text: answer.assistantContent,
    cost: answer.usage?.cost ?? null }));
}
if (failures) process.exitCode = 1;
