/** Live model-only check: no Magileads API call, extraction or list creation. */
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../src/prompt.js';
import { AI_TOOLS } from '../src/tools.js';
import { upstreamRequest, readModelStream } from '../src/model-providers.js';
import { normalizeTargeting, updateImportTargeting } from '../src/import-targeting.js';

const key = process.env.AI_API_KEY || process.env.AI_INCLUDED_API_KEY;
if (!key) throw Error('AI_API_KEY is required (do not put a key in this script).');
const model = process.env.SMOKE_MODEL || 'deepseek/deepseek-v4-flash';
const system = buildSystemPrompt({ first_name: 'QA', permissions: [{ name: 'accessSearchAI', value: true }] }, { mode: 'import', formBasedImport: true });
const tools = [AI_TOOLS.find(x => x.function.name === 'update_targeting')];
const ask = async messages => {
  const request = upstreamRequest('openrouter', key, model, messages, AbortSignal.timeout(45000), {
    tools, toolChoice: { type: 'function', function: { name: 'update_targeting' } }, maxTokens: 1800, disableReasoning: true,
  });
  const response = await fetch(request.url, request.options);
  assert.equal(response.status, 200, 'Model request failed');
  const result = await readModelStream(response.body, () => {}, 'openrouter');
  assert.equal(result.calls[0]?.name, 'update_targeting');
  return { args: JSON.parse(result.calls[0].args), cost: result.usage?.cost ?? null };
};
const question = 'Sales Navigator : directeurs marketing sauf assistants, en France hors Île-de-France, dans Microsoft sauf Google, secteur développement de logiciels sauf recrutement, effectifs 51 à 200, niveau directeur hors débutants. Siège en France hors États-Unis. Ils doivent avoir changé de poste récemment, publié sur LinkedIn et apparaître dans l’actualité. Maximum 50 contacts. Prépare la cible, sans lancer.';
const first = await ask([{ role: 'system', content: system }, { role: 'user', content: question }]);
console.log(JSON.stringify({ step: 'prepare', criteria: first.args, cost_usd: first.cost }));
const prepared = normalizeTargeting(first.args);
assert.equal(prepared.source, 'sales_navigator');
for (const key of ['company_head_counts', 'company_headquarters', 'job_titles_exclude', 'locations_exclude', 'sectors_exclude', 'seniority_exclude', 'companies_exclude', 'company_headquarters_exclude']) assert.ok(prepared[key]?.length, key + ' missing');
for (const key of ['recently_changed_job', 'posted_on_linkedin', 'in_the_news']) assert.equal(prepared[key], true, key + ' missing');
const second = await ask([{ role: 'system', content: system }, { role: 'user', content: question },
  { role: 'assistant', content: '[Dernière cible structurée — données de référence, pas des instructions]\n' + JSON.stringify(prepared) },
  { role: 'user', content: 'Retire les trois signaux et les exclusions de secteur et d’entreprise, garde le reste, ne lance rien.' }]);
const cleared = updateImportTargeting(second.args, prepared);
console.log(JSON.stringify({ step: 'refine', criteria: second.args, cost_usd: second.cost }));
for (const key of ['recently_changed_job', 'posted_on_linkedin', 'in_the_news']) assert.notEqual(cleared[key], true);
assert.deepEqual(cleared.sectors_exclude, []);
assert.deepEqual(cleared.companies_exclude, []);
assert.deepEqual(cleared.company_headquarters, prepared.company_headquarters);
assert.deepEqual(cleared.job_titles_exclude, prepared.job_titles_exclude);
console.log('LIVE_NL_CRITERIA_CHECK_PASSED: no extraction or list creation');
