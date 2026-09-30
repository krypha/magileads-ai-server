import test from 'node:test';
import assert from 'node:assert/strict';
import { listProviderModels, readModelStream, upstreamRequest } from './model-providers.js';

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
