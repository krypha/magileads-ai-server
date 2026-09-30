import test from 'node:test';
import assert from 'node:assert/strict';
import { readModelStream, resolveIncludedModel, resolveModels, upstreamRequest } from './model-providers.js';

test('included model prefers its override, inherits Simple and only defaults to Flash without either', () => {
  const saved = { AI_MODEL: process.env.AI_MODEL, AI_MODEL_INCLUDED: process.env.AI_MODEL_INCLUDED };
  try {
    for (const [included, simple, expected] of [
      ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro'],
      ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash'],
      [undefined, 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-pro'],
      ['  ', ' deepseek/deepseek-v4-pro ', 'deepseek/deepseek-v4-pro'],
      [undefined, undefined, 'deepseek/deepseek-v4-flash'],
      ['', '', 'deepseek/deepseek-v4-flash'],
    ]) {
      if (included === undefined) delete process.env.AI_MODEL_INCLUDED;
      else process.env.AI_MODEL_INCLUDED = included;
      if (simple === undefined) delete process.env.AI_MODEL;
      else process.env.AI_MODEL = simple;
      assert.equal(resolveIncludedModel(), expected);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('OpenAI legacy defaults remain, while personal providers require a selected catalog model', () => {
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

test('DeepSeek reasoning is kept for tool continuation but not shown as answer text', async () => {
  const stream = new Response([
    'data: {"choices":[{"delta":{"reasoning_content":"private thought "}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"list_contact_lists","arguments":"{}"}}]}}]}',
    'data: [DONE]',
  ].join('\n\n') + '\n\n').body;
  const visible = [];
  const result = await readModelStream(stream, text => visible.push(text), 'deepseek');
  assert.deepEqual(visible, []);
  assert.equal(result.reasoningContent, 'private thought ');
  const continuation = JSON.parse(upstreamRequest('deepseek', 'private-key', 'deepseek-v4-pro', [
    { role: 'assistant', content: null, reasoning_content: result.reasoningContent,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'list_contact_lists', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: '{}' },
  ]).options.body);
  assert.equal(continuation.messages[0].reasoning_content, 'private thought ');
  assert.ok(!JSON.stringify(continuation).includes('private-key'));
});
