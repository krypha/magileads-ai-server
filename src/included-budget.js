// The shared paid key's daily cap is enforced by OpenRouter, not by local
// counters: this server deliberately keeps no account/usage database.
const DEFAULT_DAILY_USD = 3;
const MAX_LAST_MESSAGE_CHARS = 4_000;
const MAX_HISTORY_CHARS = 24_000;

function positiveSetting(name, fallback, ceiling) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.min(value, ceiling) : fallback;
}

export const INCLUDED_REQUEST_USD = positiveSetting('AI_INCLUDED_MAX_REQUEST_USD', 0.03, 0.10);
// OpenRouter enforces these ceilings for every selected provider, including
// provider-side fallbacks. Units: dollars per MILLION tokens, not per token.
export const INCLUDED_MAX_PRICE = Object.freeze({
  prompt: positiveSetting('AI_INCLUDED_MAX_INPUT_USD_PER_M', 0.25, 1),
  completion: positiveSetting('AI_INCLUDED_MAX_OUTPUT_USD_PER_M', 1.50, 5),
  request: 0,
});
export const FREE_MAX_PRICE = Object.freeze({ prompt: 0, completion: 0, request: 0 });

/** A conservative reservation before EACH call, including the scope check.
 * UTF-8 bytes bound text token counts conservatively without a tokenizer
 * dependency. JSON framing + 1024 tokens covers message/tool serialization.
 * Actual provider usage releases unused reservations; missing usage retains it.
 * This ledger is discarded when the HTTP request ends.
 */
export class RequestBudget {
  constructor(limit = INCLUDED_REQUEST_USD) {
    this.limit = limit;
    this.spent = 0;
  }

  reserve(messages, tools, maxTokens, price = INCLUDED_MAX_PRICE) {
    const inputTokens = Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8') + 1_024;
    // Even on free fallback, stop unbounded tool-result context growth.
    if (inputTokens > 120_000) return null;
    const amount = 1.20 * (inputTokens * price.prompt + maxTokens * price.completion) / 1_000_000;
    if (this.spent + amount > this.limit) return null;
    this.spent += amount;
    return { amount, settled: false };
  }

  settle(reservation, usage) {
    if (!reservation || reservation.settled) return;
    reservation.settled = true;
    // Null/missing/invalid costs never turn a paid call into a free one.
    if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) {
      this.spent += usage.cost - reservation.amount;
    }
  }

  get exhausted() { return this.spent >= this.limit; }
}

export function sharedPromptTooLarge(messages) {
  const lastUser = [...messages].reverse().find(message => message.role === 'user');
  return (lastUser?.content.length ?? 0) > MAX_LAST_MESSAGE_CHARS ||
    messages.reduce((total, message) => total + message.content.length, 0) > MAX_HISTORY_CHARS;
}

export function paidBudgetAvailable(value, dailyLimit = DEFAULT_DAILY_USD) {
  const key = value?.data;
  const limit = Number(key?.limit);
  const remaining = Number(key?.limit_remaining);
  return key?.disabled !== true && key?.limit_reset === 'daily' &&
    Number.isFinite(limit) && limit > 0 && limit <= dailyLimit &&
    Number.isFinite(remaining) && remaining > 0;
}

/** Fail closed to the configured free model when the cap cannot be verified. */
export async function checkIncludedBudget(apiKey, fetchImpl = fetch) {
  if (!apiKey) return false;
  const base = (process.env.AI_API_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetchImpl(`${base}/key`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    return paidBudgetAvailable(await response.json());
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
