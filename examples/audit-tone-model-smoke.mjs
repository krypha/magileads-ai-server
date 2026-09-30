// Check the final audit wording with fictional Magileads data and a real model.
// AI_API_KEY and AI_MODEL_COMPLEX (or AUDIT_TEST_MODEL) come from the environment.
import { buildSystemPrompt } from '../src/prompt.js';
import { sanitize } from '../src/assistant-policy.js';
import { upstreamRequest, readModelStream } from '../src/model-providers.js';

const key = process.env.AI_API_KEY;
const model = process.env.AUDIT_TEST_MODEL || process.env.AI_MODEL_COMPLEX || process.env.AI_MODEL;
if (!key || !model) throw Error('AI_API_KEY and an audit test model are required');

const toolResult = (id, value) => ({ role: 'tool', tool_call_id: id, content: JSON.stringify(sanitize(value)) });
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const messages = [
  { role: 'system', content: buildSystemPrompt({ first_name: 'Camille', level: 'admin' }) },
  { role: 'user', content: 'Audite ma campagne « Prospection Lyon » et dis-moi quoi améliorer.' },
  { role: 'assistant', content: null, tool_calls: [toolCall('lists', 'list_campaigns', { query: 'Prospection Lyon' })] },
  toolResult('lists', { total: 1, campaigns: [{ id: 21148, workflow_id: 17910, name: 'Prospection Lyon', contacted: 240, open_rate_pct: 34.2, click_rate_pct: 7.1, reply_rate_pct: 8.8 }] }),
  { role: 'assistant', content: null, tool_calls: [
    toolCall('stats', 'get_campaign_statistics', { id: 21148 }),
    toolCall('scenario', 'get_campaign', { workflow_id: 17910 }),
  ] },
  toolResult('stats', { contacted: 240, contacts_opened: 82, contacts_clicked: 17, contacts_answered: 21,
    bounced: 35, unsubscribers: 9, steps: [{ channel: 'email', contacted: 240, opened: 82, clicked: 17, replied: 21 }] }),
  toolResult('scenario', { name: 'Prospection Lyon', steps: [
    { channel: 'email', delay_days: 0 }, { channel: 'linkedin_invitation', delay_days: 3 }, { channel: 'email', delay_days: 5 },
  ] }),
];

const request = upstreamRequest('openrouter', key, model, messages, AbortSignal.timeout(60_000), {
  tools: [], toolChoice: 'none', maxTokens: 2_000, disableReasoning: true,
});
const response = await fetch(request.url, request.options);
if (!response.ok || !response.body) throw Error(`Provider HTTP ${response.status}`);
const result = await readModelStream(response.body, () => {});
const text = result.assistantContent;
const technical = /get_campaign|list_campaigns|workflow[_ ]?id|\bAPI\b|endpoint|payload|JSON|Périmètre de cet audit|Sources techniques|Données non exposées|aucune donnée (?:n['’]a été )?inventée|désabonnés|contacts sans email|adresses invalides|bounces/i;
const unsupportedBenchmark = /moyenne (?:généralement |habituellement )?observée|au-dessus de la moyenne|\b(?:2\s?[-–]\s?5\s?%|benchmark sectoriel)\b/i;
const ok = Boolean(text.trim()) && /Prospection Lyon/i.test(text) &&
  /240|21|34[,.]2\s?%/.test(text) && !technical.test(text) && !unsupportedBenchmark.test(text) && !result.calls.length;
console.log(JSON.stringify({ model, ok, technicalMentioned: technical.test(text), unsupportedBenchmark: unsupportedBenchmark.test(text), toolCalls: result.calls.length,
  preview: text.slice(0, 900), cost: result.usage?.cost ?? null }));
if (!ok) process.exitCode = 1;
