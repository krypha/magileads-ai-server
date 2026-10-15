import test from 'node:test';
import assert from 'node:assert/strict';
import { DailyQuota, MemoryQuotaStore, RedisQuotaStore, includedOrigins, paidOriginAllowed, userDailyLimit, utcDay } from './included-quota.js';

test('the per-account allowance defaults to 15 cents and cannot exceed the whole key', () => {
  assert.equal(userDailyLimit(undefined), 0.15);
  assert.equal(userDailyLimit('0.5'), 0.5);
  assert.equal(userDailyLimit('-1'), 0.15);
  assert.equal(userDailyLimit('12'), 3);
});

test('a hold charges the ceiling up front and settling swaps it for the real cost', async () => {
  const quota = new DailyQuota(new MemoryQuotaStore(), 0.15, () => Date.parse('2026-10-15T10:00:00Z'));
  const first = await quota.hold(391, 0.03);
  const second = await quota.hold(391, 0.03);
  // Two requests in flight are both counted before either answers.
  assert.equal(await quota.spent(391), 0.06);
  await quota.settle(first, 0.004);
  // No reported cost keeps the conservative hold.
  await quota.settle(second, undefined);
  assert.ok(Math.abs(await quota.spent(391) - 0.034) < 1e-9);
  assert.equal(await quota.spent(392), 0);
});

test('a new UTC day starts from zero and drops the previous day', async () => {
  let now = Date.parse('2026-10-15T23:59:00Z');
  const store = new MemoryQuotaStore();
  const quota = new DailyQuota(store, 0.15, () => now);
  await quota.hold(391, 0.03);
  now = Date.parse('2026-10-16T00:01:00Z');
  assert.equal(utcDay(now), '2026-10-16');
  assert.equal(await quota.spent(391), 0);
  await quota.hold(391, 0.01);
  assert.deepEqual([...store.values.keys()], ['ai:included:spent:2026-10-16:391']);
});

test('an unreachable store answers null, so the caller goes free rather than unrecorded', async () => {
  const broken = { get: async () => { throw Error('down'); }, add: async () => { throw Error('down'); } };
  const quota = new DailyQuota(broken);
  assert.equal(await quota.spent(391), null);
  assert.equal(await quota.hold(391, 0.03), null);
  await quota.settle(null, 0.01);
});

test('Redis counts with INCRBYFLOAT and expires each key after two days', async () => {
  const sent = [];
  const values = new Map();
  const client = { async send(command, args) {
    sent.push([command, ...args]);
    if (command === 'GET') return values.get(args[0]) ?? null;
    if (command === 'INCRBYFLOAT') {
      const next = Number(values.get(args[0]) ?? 0) + Number(args[1]);
      values.set(args[0], String(next));
      return String(next);
    }
    return 1;
  } };
  const quota = new DailyQuota(new RedisQuotaStore(client), 0.15, () => Date.parse('2026-10-15T10:00:00Z'));
  assert.equal(await quota.spent(7), 0);
  const hold = await quota.hold(7, 0.03);
  await quota.settle(hold, 0.01);
  assert.ok(Math.abs(await quota.spent(7) - 0.01) < 1e-9);
  assert.deepEqual(sent.find(([command]) => command === 'EXPIRE'), ['EXPIRE', 'ai:included:spent:2026-10-15:7', '172800']);
});

test('the configured fronts may be written with or without a scheme', () => {
  // What production was set to, then what the default and a sloppy copy say.
  for (const value of ['beta.magileads.io', 'https://beta.magileads.io', ' "https://Beta.Magileads.io/" ']) {
    assert.equal(paidOriginAllowed('https://beta.magileads.io', includedOrigins(value)), true, value);
  }
  assert.deepEqual(includedOrigins('beta.staging.magileads.io, https://application.magileads.io/app'),
    ['beta.staging.magileads.io', 'application.magileads.io']);
  assert.equal(paidOriginAllowed('https://beta.magileads.io', includedOrigins('beta.staging.magileads.io')), false);
  assert.equal(paidOriginAllowed('http://example.test:5100', includedOrigins('example.test:5100')), true);
  assert.deepEqual(includedOrigins(''), ['beta.magileads.io', 'application.magileads.io']);
});

test('only Magileads fronts and non-browser callers reach the paid key', () => {
  const allowed = includedOrigins('https://beta.magileads.io');
  assert.equal(paidOriginAllowed('https://beta.magileads.io', allowed), true);
  assert.equal(paidOriginAllowed(undefined, allowed), true);
  assert.equal(paidOriginAllowed('http://localhost:5100', allowed), true);
  assert.equal(paidOriginAllowed('https://app.surleads.com', allowed), false);
  assert.equal(paidOriginAllowed('https://beta.magileads.io.evil.com', allowed), false);
  assert.equal(paidOriginAllowed('not a url', allowed), false);
});
