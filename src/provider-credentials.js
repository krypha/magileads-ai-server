import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PROVIDERS = new Set(['openai', 'anthropic']);

function masterKey(value) {
  if (!value) return null;
  const key = /^[a-f0-9]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  return key.length === 32 ? key : null;
}

/**
 * Per-account provider credentials, encrypted at rest with AES-256-GCM.
 * The account id comes only from authenticated GET /users/me. Neither a key nor
 * its ciphertext is returned by the HTTP status endpoint or sent to the model.
 * A single server instance owns the file; deployments must mount it persistently.
 */
export function createCredentialStore({ file, secret }) {
  const key = masterKey(secret);
  let writes = Promise.resolve();

  function assertReady() {
    if (!key || !file) throw new Error('credential_store_unavailable');
  }

  function slotFor(accountId) {
    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error('invalid_account_id');
    return createHmac('sha256', key).update(String(accountId)).digest('hex');
  }

  function assertProvider(provider) {
    if (!PROVIDERS.has(provider)) throw new Error('invalid_provider');
  }

  async function read() {
    assertReady();
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (data.version !== 1 || !data.accounts || typeof data.accounts !== 'object') {
        throw new Error('credential_store_invalid');
      }
      return data;
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, accounts: {} };
      throw error;
    }
  }

  async function write(data) {
    const directory = path.dirname(file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  function serialize(accountId, provider, value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${accountId}:${provider}`));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), data: encrypted.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  }

  function deserialize(accountId, provider, record) {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
    decipher.setAAD(Buffer.from(`${accountId}:${provider}`));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8');
  }

  function exclusive(operation) {
    const result = writes.then(operation);
    writes = result.catch(() => undefined);
    return result;
  }

  return {
    available: Boolean(key && file),
    async status(accountId) {
      assertReady();
      const slot = slotFor(accountId);
      const account = (await read()).accounts[slot] ?? {};
      return { openai: Boolean(account.openai), anthropic: Boolean(account.anthropic) };
    },
    async get(accountId, provider) {
      assertReady();
      assertProvider(provider);
      const record = (await read()).accounts[slotFor(accountId)]?.[provider];
      return record ? deserialize(accountId, provider, record) : null;
    },
    async set(accountId, provider, value) {
      assertReady();
      assertProvider(provider);
      if (typeof value !== 'string' || value.trim().length < 10 || value.length > 512 || /[\r\n]/.test(value)) {
        throw new Error('invalid_provider_key');
      }
      return exclusive(async () => {
        const data = await read();
        const slot = slotFor(accountId);
        data.accounts[slot] ??= {};
        data.accounts[slot][provider] = serialize(accountId, provider, value.trim());
        await write(data);
      });
    },
    async remove(accountId, provider) {
      assertReady();
      assertProvider(provider);
      return exclusive(async () => {
        const data = await read();
        const slot = slotFor(accountId);
        if (!data.accounts[slot]?.[provider]) return;
        delete data.accounts[slot][provider];
        if (!Object.keys(data.accounts[slot]).length) delete data.accounts[slot];
        await write(data);
      });
    },
  };
}

export const providerCredentials = createCredentialStore({
  file: process.env.AI_CREDENTIALS_FILE || '/data/provider-keys.json',
  secret: process.env.AI_CREDENTIALS_KEY,
});
