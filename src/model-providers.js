import { AI_TOOLS } from './tools.js';

export const MODEL_PROVIDERS = ['openrouter', 'openai', 'anthropic', 'gemini', 'deepseek'];
export const KEY_TYPE_FOR_PROVIDER = { openrouter: 'openrouter', openai: 'openai', anthropic: 'claude', gemini: 'gemini', deepseek: 'deepseek' };

const URLS = {
  openrouter: (process.env.AI_API_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
  openai: (process.env.OPENAI_API_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  anthropic: (process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1').replace(/\/+$/, ''),
  gemini: (process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, ''),
  deepseek: (process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
};

export function selectedModel(provider, value) {
  if (!MODEL_PROVIDERS.includes(provider)) return null;
  const model = String(value || '').trim();
  const valid = provider === 'openrouter'
    ? /^[a-z0-9][\w.-]*\/[\w.:-]{1,100}$/i.test(model)
    : /^[a-z0-9][\w.:-]{1,150}$/i.test(model);
  return valid ? model : null;
}

// /models reports access, not Chat Completions or function-call support. Keep
// only documented chat/tool families; the list of actual IDs still comes from
// the account's provider key, including its available dated snapshots.
const OPENAI_ASSISTANT_MODEL = /^(?:gpt-5(?:\.\d+)?(?:-(?:sol|terra|luna|mini|nano))?|gpt-4(?:o(?:-mini)?|\.1(?:-mini|-nano)?)|o(?:3(?:-mini)?|4-mini))(?:-\d{4}-\d{2}-\d{2})?$/i;

export function supportsOpenAiAssistantModel(model) {
  return OPENAI_ASSISTANT_MODEL.test(model);
}

function openAiNeedsNoReasoning(model) {
  const version = /^gpt-5\.(\d+)(?:-|$)/i.exec(model);
  return version && Number(version[1]) >= 4;
}

/** Provider-owned catalog; credentials are used in memory and never returned. */
export async function listProviderModels(provider, apiKey, fetcher = fetch) {
  if (!MODEL_PROVIDERS.includes(provider) || !apiKey) throw new Error('invalid_provider');
  const headers = provider === 'anthropic'
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : provider === 'gemini' ? { 'x-goog-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` };
  const collected = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${URLS[provider]}/models`);
    if (cursor) url.searchParams.set(provider === 'gemini' ? 'pageToken' : 'after_id', cursor);
    if (provider === 'gemini') url.searchParams.set('pageSize', '1000');
    const response = await fetcher(url.toString(), { headers, signal: AbortSignal.timeout(12000) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(response.status === 401 || response.status === 403 ? 'provider_key_invalid' : 'provider_models_unavailable'); }
    const payload = await response.json();
    const items = provider === 'gemini' ? payload.models : payload.data;
    if (!Array.isArray(items)) throw new Error('provider_models_unavailable');
    for (const item of items) {
      const id = provider === 'gemini' ? String(item?.name || '').replace(/^models\//, '') : item?.id;
      if (!selectedModel(provider, id)) continue;
      if (provider === 'openai' && !supportsOpenAiAssistantModel(id)) continue;
      if (provider === 'gemini' && !item.supportedGenerationMethods?.includes('generateContent')) continue;
      if (provider === 'openrouter' && Array.isArray(item.supported_parameters) && !item.supported_parameters.includes('tools')) continue;
      if (provider === 'deepseek' && Array.isArray(item.output_modalities) && !item.output_modalities.includes('text')) continue;
      collected.push({ id, name: String(item.display_name || item.name || id).slice(0, 120) });
    }
    cursor = provider === 'gemini' ? payload.nextPageToken : provider === 'anthropic' && payload.has_more ? payload.last_id : null;
    if (!cursor || collected.length >= 1000) break;
  }
  return [...new Map(collected.map(item => [item.id, item])).values()];
}

const DEFAULT_MODELS = { simple: 'gpt-5.4-mini', complex: 'gpt-5.4' };

// An explicit shared-user model wins; otherwise inherit the Simple model.
// Read deployment settings only, never the client's model/tier selection.
export function resolveIncludedModel() {
  return process.env.AI_MODEL_INCLUDED?.trim() || process.env.AI_MODEL?.trim() || 'deepseek/deepseek-v4-flash';
}

export function resolveModels(provider, tier, customModel) {
  if (!MODEL_PROVIDERS.includes(provider)) return [];
  if (tier === 'custom') {
    if (process.env.ALLOW_CUSTOM_MODEL === 'false') return [];
    const model = selectedModel(provider, customModel);
    return model ? [model] : [];
  }
  if (provider === 'openrouter') {
    if (tier === 'free') return (process.env.AI_MODEL_FREE || 'openrouter/free').split(',').map(s => s.trim()).filter(Boolean);
    return [tier === 'complex' ? process.env.AI_MODEL_COMPLEX || process.env.AI_MODEL : process.env.AI_MODEL].filter(Boolean);
  }
  // A user's direct API key is billed by the provider: never call it on a
  // tier labelled "free", even if the front accidentally sends one.
  if (tier === 'free') return [];
  if (provider !== 'openai') return [];
  const env = { simple: process.env.OPENAI_MODEL, complex: process.env.OPENAI_MODEL_COMPLEX };
  return [env[tier] || DEFAULT_MODELS[tier]].filter(Boolean);
}

function anthropicMessages(conversation) {
  const system = conversation.filter(item => item.role === 'system').map(item => item.content).join('\n');
  const messages = [];
  for (const item of conversation) {
    if (item.role === 'system') continue;
    if (item.role === 'tool') {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: item.tool_call_id, content: item.content || '' }] });
    } else if (item.role === 'assistant' && item.tool_calls?.length) {
      messages.push({ role: 'assistant', content: [
        ...(item.content ? [{ type: 'text', text: item.content }] : []),
        ...item.tool_calls.map(call => ({ type: 'tool_use', id: call.id, name: call.function.name,
          input: JSON.parse(call.function.arguments || '{}') })),
      ] });
    } else messages.push({ role: item.role, content: item.content || '' });
  }
  return { system, messages };
}

/** Fixed provider hosts. A browser cannot supply a URL or route a key elsewhere. */
export function upstreamRequest(provider, apiKey, model, conversation, signal, { tools = AI_TOOLS, toolChoice = 'auto', maxTokens, maxPrice, disableReasoning = false } = {}) {
  if (provider === 'anthropic') {
    const { system, messages } = anthropicMessages(conversation);
    // Current Claude models can reject forced tool_choice. Ask through the
    // system instruction and keep the server's existing tool-call verification.
    const requiredTool = typeof toolChoice === 'object' ? toolChoice.function?.name : null;
    return { url: `${URLS.anthropic}/messages`, options: { method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, system: requiredTool ? `${system}\nAppelle uniquement l’outil ${requiredTool} maintenant ; ne réponds pas en texte.` : system,
        messages, stream: true, max_tokens: maxTokens || 4096,
        tools: tools.map(tool => ({ name: tool.function.name, description: tool.function.description,
          input_schema: tool.function.parameters })),
        tool_choice: toolChoice === 'none' ? { type: 'none' } : toolChoice === 'auto' ? { type: 'auto' }
          : { type: 'auto' } }), signal } };
  }
  return {
    url: `${provider === 'gemini' ? `${URLS.gemini}/openai` : URLS[provider]}/chat/completions`,
    options: {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: conversation, tools, tool_choice: toolChoice, stream: true,
        ...(provider === 'openai' && openAiNeedsNoReasoning(model) ? { reasoning_effort: 'none' } : {}),
        ...(maxTokens ? provider === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens } : {}),
        ...(provider === 'openrouter' && maxPrice ? { provider: { max_price: maxPrice, require_parameters: true } } : {}),
        ...(provider === 'openrouter' && disableReasoning ? { reasoning: { effort: 'none' } } : {}) }),
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
export async function readModelStream(stream, onText, provider = 'openai') {
  let assistantContent = '';
  let reasoningContent = '';
  let usage = null;
  const toolCalls = [];
  for await (const frame of sseFrames(stream)) {
    if (frame.data === '[DONE]') continue;
    let payload;
    try { payload = JSON.parse(frame.data); } catch { continue; }
    if (provider === 'anthropic') {
      if (payload.type === 'error') throw new Error('upstream_stream_error');
      if (payload.type === 'message_start') usage = payload.message?.usage ?? usage;
      if (payload.type === 'message_delta') usage = { ...usage, ...payload.usage };
      if (payload.type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
        toolCalls[payload.index] = { id: payload.content_block.id, name: payload.content_block.name, args: '' };
      }
      if (payload.type === 'content_block_delta') {
        if (payload.delta?.type === 'text_delta') { assistantContent += payload.delta.text; onText(payload.delta.text); }
        if (payload.delta?.type === 'input_json_delta' && toolCalls[payload.index]) toolCalls[payload.index].args += payload.delta.partial_json;
      }
      continue;
    }
    if (payload.error || payload.choices?.some(choice => choice.finish_reason === 'error')) throw new Error('upstream_stream_error');
    if (payload.usage) usage = payload.usage;
    const delta = payload.choices?.[0]?.delta;
    if (!delta) continue;
    if (provider === 'deepseek' && typeof delta.reasoning_content === 'string') reasoningContent += delta.reasoning_content;
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
    reasoningContent,
    usage,
    calls: toolCalls.filter(call => call?.name).map(call => ({
      id: call.id,
      name: call.name,
      args: call.args,
    })),
  };
}
