import { AI_TOOLS } from './tools.js';

export const MODEL_PROVIDERS = ['openrouter', 'openai'];

const URLS = {
  openrouter: (process.env.AI_API_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
  openai: (process.env.OPENAI_API_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
};

const DEFAULT_MODELS = { simple: 'gpt-5.4-mini', complex: 'gpt-5.4' };

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
  const env = { simple: process.env.OPENAI_MODEL, complex: process.env.OPENAI_MODEL_COMPLEX };
  return [env[tier] || DEFAULT_MODELS[tier]].filter(Boolean);
}

/** Fixed provider hosts. A browser cannot supply a URL or route a key elsewhere. */
export function upstreamRequest(provider, apiKey, model, conversation, signal) {
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

/** Parse OpenRouter/OpenAI chat-completion SSE into text and tool calls. */
export async function readModelStream(stream, onText) {
  let assistantContent = '';
  const toolCalls = [];
  for await (const frame of sseFrames(stream)) {
    if (frame.data === '[DONE]') continue;
    let payload;
    try { payload = JSON.parse(frame.data); } catch { continue; }
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
  return {
    assistantContent,
    calls: toolCalls.filter(call => call?.name).map(call => ({
      id: call.id,
      name: call.name,
      args: call.args,
    })),
  };
}
