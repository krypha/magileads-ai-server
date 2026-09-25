// The shared paid key's daily cap is enforced by OpenRouter, not by local
// counters: this server deliberately keeps no account/usage database.
const DEFAULT_DAILY_USD = 3;
const MAX_LAST_MESSAGE_CHARS = 4_000;
const MAX_HISTORY_CHARS = 24_000;

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
