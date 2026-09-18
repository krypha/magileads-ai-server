import { AI_TOOLS } from './tools.js';

export const MODEL_PROVIDERS = ['openrouter', 'openai', 'anthropic'];

const URLS = {
  openrouter: (process.env.AI_API_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
  openai: (process.env.OPENAI_API_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  anthropic: (process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1').replace(/\/+$/, ''),
};

const DEFAULT_MODELS = {
  openai: { simple: 'gpt-5.4-mini', complex: 'gpt-5.4' },
  anthropic: { simple: 'claude-haiku-4-5-20251001', complex: 'claude-sonnet-5' },
};

export function resolveModels(provider, tier, customModel) {
  if (!MODEL_PROVIDERS.includes(provider)) return [];
  if (tier === 'custom') {
    if (process.env.ALLOW_CUSTOM_MODEL === 'false') return [];
    const model = String(customModel || '').trim();
    const valid = provider === 'openrouter'
      ? /^[a-z0-9][\w.-]*\/[\w.:-]{1,80}$/i.test(model)
      : /^[a-z0-9][\w.:-]{1,100}$/i.test(model);
    return valid ? [model] : [];
  }
  if (provider === 'openrouter') {
    if (tier === 'free') return (process.env.AI_MODEL_FREE || 'openrouter/free').split(',').map(s => s.trim()).filter(Boolean);
    return [tier === 'complex' ? process.env.AI_MODEL_COMPLEX || process.env.AI_MODEL : process.env.AI_MODEL].filter(Boolean);
  }
  // A user's direct API key is billed by the provider: never call it on a
  // tier labelled "free", even if the front accidentally sends one.
  if (tier === 'free') return [];
  const env = provider === 'openai'
    ? { simple: process.env.OPENAI_MODEL, complex: process.env.OPENAI_MODEL_COMPLEX }
    : { simple: process.env.ANTHROPIC_MODEL, complex: process.env.ANTHROPIC_MODEL_COMPLEX };
  return [env[tier] || DEFAULT_MODELS[provider][tier]].filter(Boolean);
}

/** Fixed provider hosts. A browser cannot supply a URL or route a key elsewhere. */
export function upstreamRequest(provider, apiKey, model, conversation, signal) {
  if (provider === 'anthropic') {
    return {
      url: `${URLS.anthropic}/messages`,
      options: {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: conversation[0]?.content ?? '',
          messages: anthropicMessages(conversation.slice(1)),
          tools: AI_TOOLS.map(({ function: fn }) => ({ name: fn.name, description: fn.description, input_schema: fn.parameters })),
          tool_choice: { type: 'auto' },
          stream: true,
        }),
        signal,
      },
    };
  }
  return {
    url: `${URLS[provider]}/chat/completions`,
    options: {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: conversation, tools: AI_TOOLS, tool_choice: 'auto', stream: true }),
      signal,
    },
  };
}

export function anthropicMessages(conversation) {
  const messages = [];
  for (const message of conversation) {
    if (message.role === 'tool') {
      const result = { type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content };
      const previous = messages.at(-1);
      if (previous?.role === 'user' && Array.isArray(previous.content) && previous.content[0]?.type === 'tool_result') {
        previous.content.push(result);
      } else {
        messages.push({ role: 'user', content: [result] });
      }
    } else if (message.role === 'assistant' && message.tool_calls?.length) {
      const blocks = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls) {
        let input;
        try { input = JSON.parse(call.function.arguments || '{}'); } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
      }
      messages.push({ role: 'assistant', content: blocks });
    } else if (message.role === 'user' || message.role === 'assistant') {
      messages.push({ role: message.role, content: message.content || '' });
    }
  }
  return messages;
}

async function* sseFrames(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const event = raw.split(/\r?\n/).find(line => line.startsWith('event:'))?.slice(6).trim() ?? null;
        const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) yield { event, data };
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Normalises both streaming APIs to the tool-call shape the existing loop uses. */
export async function readModelStream(stream, provider, onText) {
  let assistantContent = '';
  const toolCalls = [];
  for await (const frame of sseFrames(stream)) {
    if (frame.data === '[DONE]') continue;
    let payload;
    try { payload = JSON.parse(frame.data); } catch { continue; }
    if (provider === 'anthropic') {
      if (frame.event === 'error') throw new Error('upstream_stream_error');
      if (frame.event === 'content_block_start' && payload.content_block?.type === 'tool_use') {
        const block = payload.content_block;
        toolCalls[payload.index] = { id: block.id, name: block.name, args: '', initial: block.input ?? {} };
      }
      if (frame.event === 'content_block_delta') {
        if (payload.delta?.type === 'text_delta' && payload.delta.text) {
          assistantContent += payload.delta.text;
          onText(payload.delta.text);
        }
        if (payload.delta?.type === 'input_json_delta' && toolCalls[payload.index]) {
          toolCalls[payload.index].args += payload.delta.partial_json ?? '';
        }
      }
    } else {
      const delta = payload.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) {
        assistantContent += delta.content;
        onText(delta.content);
      }
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        if (!toolCalls[index]) toolCalls[index] = { id: '', name: '', args: '' };
        const slot = toolCalls[index];
        if (call.id) slot.id = call.id;
        if (call.function?.name) slot.name = call.function.name;
        if (call.function?.arguments) slot.args += call.function.arguments;
      }
    }
  }
  return {
    assistantContent,
    calls: toolCalls.filter(call => call?.name).map(call => ({
      id: call.id,
      name: call.name,
      args: call.args || JSON.stringify(call.initial ?? {}),
    })),
  };
}
