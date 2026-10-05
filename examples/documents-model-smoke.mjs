// Real-provider test using fictional values only, without Magileads API calls.
// Provide AI_API_KEY and AI_MODEL in the environment. Nothing is persisted.
import { readModelStream, upstreamRequest } from '../src/model-providers.js';
import { buildSystemPrompt } from '../src/prompt.js';
import { createDocument, DOCUMENT_TOOL } from '../src/documents.js';

const key = process.env.AI_API_KEY, model = process.env.DOCUMENT_TEST_MODEL || process.env.AI_MODEL;
if (!key || !model) throw Error('AI_API_KEY and AI_MODEL are required');
async function call(messages, tools, options = {}) {
  const request = upstreamRequest('openrouter', key, model, messages, AbortSignal.timeout(40_000), { tools, ...options });
  const response = await fetch(request.url, request.options);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message = typeof body?.error?.message === 'string' ? body.error.message.replaceAll(key, '[secret]').slice(0, 250) : '';
    throw Error(`Provider HTTP ${response.status}: ${message}`);
  }
  return readModelStream(response.body, () => {});
}
const data = 'Je te fournis ce tableau de test pour une matrice Magileads (valeurs fictives, ne pas interroger l’API) : Marketing / CMO, Île-de-France, Services, 24 contacts ; Juridique / légal, Germany, Industrie, 0 contact. Utilise exactement ces données et indique que ce sont des données de test.';
let failures = 0;
for (const format of ['docx', 'csv', 'xlsx']) {
  const content = `${data} Crée un fichier ${format} téléchargeable avec les colonnes Métier, Localisation du contact, Secteur, Contacts. Le titre est Matrice de test.`;
  const answer = await call([{ role: 'system', content: buildSystemPrompt({ first_name: 'Test', level: 'admin' }) },
    { role: 'user', content }], [DOCUMENT_TOOL], { maxTokens: 2_000, disableReasoning: model !== 'openrouter/free' && !model.endsWith(':free') });
  let result;
  try { result = answer.calls.length === 1 && answer.calls[0].name === 'create_document' ? createDocument(JSON.parse(answer.calls[0].args)) : null; } catch { /* invalid arguments are a failed test */ }
  const rows = result?.document?.sections.flatMap(section => section.table?.rows ?? []) ?? [];
  const ok = result?.status === 'document_ready' && result.document.format === format && rows.length === 2 &&
    rows.some(row => row.includes(24) && row.includes('Île-de-France')) && rows.some(row => row.includes(0) && row.includes('Germany'));
  console.log(JSON.stringify({ model, format, ok, rows: rows.length, error: result?.error ?? null,
    cost: answer.usage?.cost ?? 0 }));
  if (!ok) failures++;
}
if (failures) process.exitCode = 1;
