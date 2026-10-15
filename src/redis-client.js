// A minimal Redis client: the three commands the included-AI quota sends
// (GET, INCRBYFLOAT, EXPIRE), over plain TCP or TLS.
//
// Why not Bun's built-in RedisClient: it does not send SNI on a `rediss://`
// connection (Bun 1.3.14, measured), and a Redis behind Traefik is routed BY
// that name — without it Traefik answers with its default self-signed
// certificate and the connection fails (UNABLE_TO_VERIFY_LEAF_SIGNATURE).
// node:tls sends it, verifies the chain, and runs on Bun and Node alike, so
// the quota needs no runtime of its own any more.

import net from 'node:net';
import tls from 'node:tls';

function encode(command, args) {
  const parts = [command, ...args].map(String);
  return `*${parts.length}\r\n` + parts.map(part => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join('');
}

/** One reply off the front of `buffer`, or null when it is not complete yet. */
function parseReply(buffer, offset = 0) {
  const end = buffer.indexOf('\r\n', offset);
  if (end === -1) return null;
  const type = String.fromCharCode(buffer[offset]);
  const line = buffer.toString('utf8', offset + 1, end);
  const next = end + 2;
  if (type === '+') return { value: line, next };
  if (type === '-') return { value: new Error(line), next };
  if (type === ':') return { value: Number(line), next };
  if (type === '$') {
    const length = Number(line);
    if (length < 0) return { value: null, next };
    if (buffer.length < next + length + 2) return null;
    return { value: buffer.toString('utf8', next, next + length), next: next + length + 2 };
  }
  if (type === '*') {
    const count = Number(line);
    if (count < 0) return { value: null, next };
    const items = [];
    let cursor = next;
    for (let index = 0; index < count; index++) {
      const item = parseReply(buffer, cursor);
      if (!item) return null;
      items.push(item.value);
      cursor = item.next;
    }
    return { value: items, next: cursor };
  }
  throw new Error(`redis_protocol_error: ${type}`);
}

export class RedisClient {
  constructor(url, { timeoutMs = 3_000 } = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') throw new Error('invalid_redis_url');
    this.secure = parsed.protocol === 'rediss:';
    this.host = parsed.hostname;
    this.port = Number(parsed.port) || 6379;
    this.username = decodeURIComponent(parsed.username);
    this.password = decodeURIComponent(parsed.password);
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.pending = [];
    this.buffer = Buffer.alloc(0);
  }

  connect() {
    const options = { host: this.host, port: this.port };
    const socket = this.secure
      // `servername` is the SNI the router needs; the chain is verified.
      ? tls.connect({ ...options, servername: this.host })
      : net.connect(options);
    socket.setNoDelay(true);
    // Events of a socket already replaced are ignored: a timed-out connection
    // closes late, and its close must not fail the commands of the new one.
    socket.on('data', chunk => { if (this.socket === socket) this.receive(chunk); });
    socket.on('error', error => { if (this.socket === socket) this.reset(error); });
    socket.on('close', () => { if (this.socket === socket) this.reset(new Error('redis_connection_closed')); });
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    if (this.password) {
      const auth = this.username ? [this.username, this.password] : [this.password];
      // Queued first, so nothing runs unauthenticated; a refusal fails it.
      this.enqueue('AUTH', auth).catch(() => undefined);
    }
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      let reply;
      try { reply = parseReply(this.buffer); } catch (error) { this.reset(error); return; }
      if (!reply) return;
      this.buffer = this.buffer.subarray(reply.next);
      const waiting = this.pending.shift();
      if (!waiting) continue;
      clearTimeout(waiting.timer);
      if (reply.value instanceof Error) waiting.reject(reply.value);
      else waiting.resolve(reply.value);
    }
  }

  /** Fails everything in flight; the next command opens a new connection. */
  reset(error) {
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    for (const waiting of this.pending.splice(0)) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
  }

  enqueue(command, args) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.reset(new Error('redis_timeout')), this.timeoutMs);
      this.pending.push({ resolve, reject, timer });
      this.socket.write(encode(command, args));
    });
  }

  /** Same signature as Bun's client, so the quota store does not change. */
  async send(command, args = []) {
    if (!this.socket) this.connect();
    return this.enqueue(command, args);
  }

  close() {
    this.socket?.end();
    this.socket = null;
  }
}
