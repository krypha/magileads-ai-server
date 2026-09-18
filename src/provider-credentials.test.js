import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCredentialStore } from './provider-credentials.js';

test('provider keys are encrypted, scoped to the authenticated account, replaceable and removable', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'magileads-provider-keys-'));
  const file = path.join(directory, 'keys.json');
  const store = createCredentialStore({ file, secret: randomBytes(32).toString('hex') });
  try {
    assert.deepEqual(await store.status(1), { openai: false, anthropic: false });
    await Promise.all([
      store.set(1, 'openai', 'sk-openai-account-one'),
      store.set(2, 'openai', 'sk-openai-account-two'),
      store.set(1, 'anthropic', 'sk-anthropic-account-one'),
    ]);
    assert.equal(await store.get(1, 'openai'), 'sk-openai-account-one');
    assert.equal(await store.get(2, 'openai'), 'sk-openai-account-two');
    assert.equal(await store.get(2, 'anthropic'), null);
    assert.deepEqual(await store.status(1), { openai: true, anthropic: true });
    const onDisk = await readFile(file, 'utf8');
    assert.ok(!onDisk.includes('sk-openai-account-one'));
    assert.ok(!onDisk.includes('sk-anthropic-account-one'));
    assert.ok(!onDisk.includes('"1"'));
    await store.set(1, 'openai', 'sk-openai-replacement');
    assert.equal(await store.get(1, 'openai'), 'sk-openai-replacement');
    await store.remove(1, 'openai');
    assert.equal(await store.get(1, 'openai'), null);
    assert.equal(await store.get(2, 'openai'), 'sk-openai-account-two');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('store refuses an absent encryption key and malformed API keys', async () => {
  const disabled = createCredentialStore({ file: '/tmp/unused.json', secret: '' });
  assert.equal(disabled.available, false);
  await assert.rejects(disabled.set(1, 'openai', 'sk-long-enough'), /credential_store_unavailable/);
  const store = createCredentialStore({ file: '/tmp/unused.json', secret: randomBytes(32).toString('hex') });
  await assert.rejects(store.set(1, 'openai', 'short'), /invalid_provider_key/);
  await assert.rejects(store.set(1, 'openai', 'sk-line\nsecond'), /invalid_provider_key/);
  await assert.rejects(store.set(1, 'openrouter', 'sk-long-enough'), /invalid_provider/);
});
