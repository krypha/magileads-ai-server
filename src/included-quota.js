// Each account's share of the shared paid key, per UTC day.
//
// OpenRouter caps the shared key at $3 a day for everybody together; nothing
// stopped one account from spending all of it, with one heavy audit or with a
// hundred small questions. So every account gets its own daily allowance in
// DOLLARS, read from the cost OpenRouter reports for each call (estimated
// conservatively when it reports none): heavy and light requests draw on the
// same balance, and past it that account answers on the free model until
// midnight UTC — when OpenRouter resets the key — while the others keep the
// paid one.
//
// The counters live in Redis when REDIS_URL is set (redis-client.js, no
// dependency), so every instance and every restart sees the same balance.
// Without it they live in this process: correct for one instance, reset by a
// restart, and the $3 cap on the key still bounds the total either way.

import { RedisClient } from './redis-client.js';

const DEFAULT_USER_DAILY_USD = 0.15;
const DAY_SECONDS = 86_400;

function positiveSetting(value, fallback, ceiling) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(number, ceiling) : fallback;
}

export function userDailyLimit(value = process.env.AI_INCLUDED_USER_DAILY_USD) {
  return positiveSetting(value, DEFAULT_USER_DAILY_USD, 3);
}

/** The day OpenRouter's daily limit counts: it resets at midnight UTC. */
export function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

export class MemoryQuotaStore {
  constructor() { this.values = new Map(); }

  async get(key) { return this.values.get(key) ?? 0; }

  async add(key, amount) {
    // Keys carry their day; yesterday's are dead weight.
    const day = key.split(':').at(-2);
    for (const stored of this.values.keys()) if (stored.split(':').at(-2) !== day) this.values.delete(stored);
    const next = (this.values.get(key) ?? 0) + amount;
    this.values.set(key, next);
    return next;
  }
}

export class RedisQuotaStore {
  constructor(client) { this.client = client; }

  async get(key) {
    const value = Number(await this.client.send('GET', [key]));
    return Number.isFinite(value) ? value : 0;
  }

  async add(key, amount) {
    const next = Number(await this.client.send('INCRBYFLOAT', [key, amount.toFixed(6)]));
    // Two days, so a request that straddles midnight still settles its key.
    await this.client.send('EXPIRE', [key, String(2 * DAY_SECONDS)]);
    return next;
  }
}

export async function createQuotaStore(url = process.env.REDIS_URL?.trim()) {
  if (!url) return { store: new MemoryQuotaStore(), shared: false };
  return { store: new RedisQuotaStore(new RedisClient(url)), shared: true };
}

export class DailyQuota {
  constructor(store, limit = userDailyLimit(), clock = Date.now) {
    this.store = store;
    this.limit = limit;
    this.clock = clock;
  }

  key(accountId, day = utcDay(this.clock())) {
    return `ai:included:spent:${day}:${accountId}`;
  }

  /** What the account has spent today, or null when the store cannot say. */
  async spent(accountId) {
    try { return await this.store.get(this.key(accountId)); } catch { return null; }
  }

  /**
   * Charges the most one request may cost BEFORE it runs, so parallel
   * requests cannot all pass the check on the same balance. `settle` then
   * replaces that hold with what the request really cost. Returns null when
   * the store is unreachable: an unrecorded paid call is the one thing this
   * must never allow, so the caller goes free instead.
   */
  async hold(accountId, amount) {
    const key = this.key(accountId);
    try {
      await this.store.add(key, amount);
      return { key, amount };
    } catch {
      return null;
    }
  }

  async settle(hold, actual) {
    if (!hold) return;
    const cost = Number.isFinite(actual) && actual >= 0 ? actual : hold.amount;
    try { await this.store.add(hold.key, cost - hold.amount); } catch { /* the hold stays charged */ }
  }
}

// The Magileads fronts. A white label's users bring their own key (a personal
// integration); until a tenant-level key exists, the shared paid key is not
// theirs to spend and they answer on the free model.
const DEFAULT_INCLUDED_ORIGINS = 'https://beta.magileads.io,https://application.magileads.io';

export function includedOrigins(value = process.env.AI_INCLUDED_ORIGINS) {
  return (value?.trim() || DEFAULT_INCLUDED_ORIGINS).split(',').map(origin => origin.trim()).filter(Boolean);
}

/**
 * Whether a request may use the shared paid key at all. No Origin header means
 * no browser (a script, a test): the per-account allowance still applies, so
 * there is nothing a missing header buys beyond what a Magileads tab gets.
 */
export function paidOriginAllowed(origin, allowed = includedOrigins()) {
  if (!origin) return true;
  if (allowed.includes('*') || allowed.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}
