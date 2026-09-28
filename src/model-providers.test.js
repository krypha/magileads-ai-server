import test from 'node:test';
import assert from 'node:assert/strict';
import { readModelStream, resolveModels, upstreamRequest } from './model-providers.js';

test('OpenAI uses its own models; Claude cannot be routed', () => {
  assert.deepEqual(resolveModels('openai', 'free'), []);
  assert.deepEqual(resolveModels('openai', 'simple'), [process.env.OPENAI_MODEL || 'gpt-5.4-mini']);
  assert.deepEqual(resolveModels('openai', 'custom', 'gpt-5.4-mini'), ['gpt-5.4-mini']);
  assert.deepEqual(resolveModels('anthropic', 'simple'), []);
  assert.deepEqual(resolveModels('openrouter', 'custom', 'gpt-5.4-mini'), []);
  assert.deepEqual(resolveModels('openai', 'custom', 'https://evil.test'), []);
});

test('OpenAI receives its integration key only in an authorization header', () => {
  const request = upstreamRequest('openai', 'sk-openai-from-magileads', 'gpt-5.4-mini', [
    { role: 'system', content: 'System rules' },
    { role: 'user', content: 'My lists' },
  ]);
  assert.match(request.url, /\/chat\/completions$/);
  assert.equal(request.options.headers.Authorization, 'Bearer sk-openai-from-magileads');
  assert.ok(!request.options.body.includes('sk-openai-from-magileads'));
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'gpt-5.4-mini');
  assert.ok(body.tools.some(tool => tool.function.name === 'list_contact_lists'));
  assert.ok(!body.tools.some(tool => /delete|remove|purge/.test(tool.function.name)));
});

test('OpenAI SSE streams text and assembles split tool arguments', async () => {
  const frames = [
    { choices: [{ delta: { content: 'Je lis ' } }] },
    { choices: [{ delta: { content: 'vos listes.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tool-1', function: { name: 'list_contact_lists', arguments: '{"sort":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"contacts"}' } }] } }] },
  ].map(data => `data: ${JSON.stringify(data)}\n\n`).join('');
  const stream = new ReadableStream({
    start(controller) {
      for (let index = 0; index < frames.length; index += 7) {
        controller.enqueue(new TextEncoder().encode(frames.slice(index, index + 7)));
      }
      controller.close();
    },
  });
  const deltas = [];
  const result = await readModelStream(stream, text => deltas.push(text));
  assert.deepEqual(deltas, ['Je lis ', 'vos listes.']);
  assert.equal(result.assistantContent, 'Je lis vos listes.');
  assert.deepEqual(result.calls, [{ id: 'tool-1', name: 'list_contact_lists', args: '{"sort":"contacts"}' }]);
});

test('OpenRouter usage-only final frames are captured and price ceilings stay out of OpenAI requests', async () => {
  const stream = new Response('data: {"choices":[],"usage":{"cost":0.0004}}\n\ndata: [DONE]\n\n').body;
  assert.deepEqual((await readModelStream(stream, () => {})).usage, { cost: 0.0004 });
  const options = { maxTokens: 512, maxPrice: { prompt: 0.25, completion: 1.5, request: 0 }, disableReasoning: true };
  const router = JSON.parse(upstreamRequest('openrouter', 'key', 'model', [], undefined, options).options.body);
  assert.deepEqual(router.provider.max_price, options.maxPrice);
  assert.equal(router.provider.require_parameters, true);
  assert.equal(router.reasoning.effort, 'none');
  assert.equal(JSON.parse(upstreamRequest('openai', 'key', 'model', [], undefined, options).options.body).provider, undefined);
});
