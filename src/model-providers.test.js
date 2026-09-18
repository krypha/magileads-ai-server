import test from 'node:test';
import assert from 'node:assert/strict';
import { anthropicMessages, readModelStream, resolveModels, upstreamRequest } from './model-providers.js';

test('direct providers reject the free tier and use provider-specific model ids', () => {
  assert.deepEqual(resolveModels('openai', 'free'), []);
  assert.deepEqual(resolveModels('anthropic', 'free'), []);
  assert.deepEqual(resolveModels('openai', 'custom', 'gpt-5.4-mini'), ['gpt-5.4-mini']);
  assert.deepEqual(resolveModels('anthropic', 'custom', 'claude-sonnet-5'), ['claude-sonnet-5']);
  assert.deepEqual(resolveModels('openrouter', 'custom', 'gpt-5.4-mini'), []);
  assert.deepEqual(resolveModels('openai', 'custom', 'https://evil.test'), []);
});

test('Anthropic request uses the native Messages API and converts tool round trips', () => {
  const conversation = [
    { role: 'system', content: 'System rules' },
    { role: 'user', content: 'My lists' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'list_contact_lists', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'tool-1', content: '{"lists":[]}' },
  ];
  const request = upstreamRequest('anthropic', 'sk-anthropic-test', 'claude-sonnet-5', conversation);
  assert.match(request.url, /\/messages$/);
  assert.equal(request.options.headers['x-api-key'], 'sk-anthropic-test');
  assert.equal(request.options.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(request.options.body);
  assert.equal(body.system, 'System rules');
  assert.equal(body.messages[1].content[0].type, 'tool_use');
  assert.equal(body.messages[2].content[0].type, 'tool_result');
  assert.ok(body.tools.some(tool => tool.name === 'list_contact_lists'));
  assert.ok(!body.tools.some(tool => /delete|remove|purge/.test(tool.name)));
  assert.ok(!request.options.body.includes('sk-anthropic-test'));
  assert.deepEqual(anthropicMessages(conversation.slice(1)), body.messages);
});

test('native Claude SSE streams text and assembles tool input split across frames', async () => {
  const frames = [
    ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Je lis ' } }],
    ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'vos listes.' } }],
    ['content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'list_contact_lists', input: {} } }],
    ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"sort":' } }],
    ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"contacts"}' } }],
    ['message_stop', { type: 'message_stop' }],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  const stream = new ReadableStream({
    start(controller) {
      for (let index = 0; index < frames.length; index += 7) {
        controller.enqueue(new TextEncoder().encode(frames.slice(index, index + 7)));
      }
      controller.close();
    },
  });
  const deltas = [];
  const result = await readModelStream(stream, 'anthropic', text => deltas.push(text));
  assert.deepEqual(deltas, ['Je lis ', 'vos listes.']);
  assert.equal(result.assistantContent, 'Je lis vos listes.');
  assert.deepEqual(result.calls, [{ id: 'tool-1', name: 'list_contact_lists', args: '{"sort":"contacts"}' }]);
});
