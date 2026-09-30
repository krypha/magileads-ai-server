import test from 'node:test';
import assert from 'node:assert/strict';
import { listProviderModels, readModelStream, supportsOpenAiAssistantModel, upstreamRequest } from './model-providers.js';

test('provider catalog is fetched with its own key and returns model metadata only', async () => {
  const fixtures = {
    openai: { data: [{ id: 'gpt-5.4-mini' }, { id: 'text-embedding-3-small' }] },
    anthropic: { data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }], has_more: false },
    gemini: { models: [{ name: 'models/gemini-3-flash', displayName: 'Gemini 3 Flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }] },
    deepseek: { data: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', output_modalities: ['text'] }] },
    openrouter: { data: [{ id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', supported_parameters: ['tools'] },
      { id: 'other/embed', supported_parameters: [] }] },
  };
  for (const [provider, payload] of Object.entries(fixtures)) {
    const models = await listProviderModels(provider, `private-${provider}`, async (url, options) => {
      assert.match(url, /\/models/);
      assert.equal(options.headers[provider === 'anthropic' ? 'x-api-key' : provider === 'gemini' ? 'x-goog-api-key' : 'Authorization'],
        provider === 'anthropic' || provider === 'gemini' ? `private-${provider}` : `Bearer private-${provider}`);
      return new Response(JSON.stringify(payload));
    });
    assert.equal(models.length, 1, provider);
    assert.ok(!JSON.stringify(models).includes('private-'));
  }
});

test('OpenAI catalog keeps chat models with tools and hides unrelated or Responses-only models', async () => {
  const available = ['gpt-5.6-sol', 'gpt-5.6-terra-2026-07-28', 'gpt-5.4-mini', 'gpt-4.1-mini',
    'text-embedding-3-small', 'gpt-5.4-pro', 'gpt-6-astra', 'gpt-image-2', 'whisper-1'];
  const models = await listProviderModels('openai', 'private-key', async () => Response.json({
    data: available.map(id => ({ id })),
  }));
  assert.deepEqual(models.map(item => item.id), available.slice(0, 4));
  assert.equal(supportsOpenAiAssistantModel('gpt-5.6-sol'), true);
  assert.equal(supportsOpenAiAssistantModel('gpt-5.4-pro'), false);
});

test('OpenAI GPT-5.6 tool requests disable reasoning and use current completion limit parameter', () => {
  const request = upstreamRequest('openai', 'private-key', 'gpt-5.6-sol',
    [{ role: 'user', content: 'Mes listes' }], undefined, { maxTokens: 2048 });
  const body = JSON.parse(request.options.body);
  assert.equal(body.reasoning_effort, 'none');
  assert.equal(body.max_completion_tokens, 2048);
  assert.equal(Object.hasOwn(body, 'max_tokens'), false);
  assert.ok(!request.options.body.includes('private-key'));
  const older = JSON.parse(upstreamRequest('openai', 'private-key', 'gpt-4.1-mini',
    [{ role: 'user', content: 'Mes listes' }], undefined, { maxTokens: 2048 }).options.body);
  assert.equal(Object.hasOwn(older, 'reasoning_effort'), false);
  assert.equal(older.max_completion_tokens, 2048);
});

test('Claude uses native Messages tool calls and text stream', async () => {
  const request = upstreamRequest('anthropic', 'claude-private', 'claude-sonnet-5', [
    { role: 'system', content: 'Use tools' }, { role: 'user', content: 'My lists' },
  ], undefined, { toolChoice: { type: 'function', function: { name: 'list_contact_lists' } } });
  assert.match(request.url, /\/messages$/);
  assert.equal(request.options.headers['x-api-key'], 'claude-private');
  const body = JSON.parse(request.options.body);
  assert.equal(body.tool_choice.type, 'auto');
  assert.match(body.system, /Appelle uniquement l’outil list_contact_lists/);
  assert.ok(!request.options.body.includes('claude-private'));
  const frames = [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Je cherche.' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'list_contact_lists', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"DAF"}' } },
  ].map(item => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join('');
  const text = [];
  const answer = await readModelStream(new Response(frames).body, delta => text.push(delta), 'anthropic');
  assert.deepEqual(text, ['Je cherche.']);
  assert.equal(answer.assistantContent, 'Je cherche.');
  assert.deepEqual(answer.calls, [{ id: 'tool-1', name: 'list_contact_lists', args: '{"query":"DAF"}' }]);
});
