import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { RedisClient } from './redis-client.js';

/** A Redis that answers from a script, and records every command it reads. */
async function fakeRedis(answer) {
  const received = [];
  const server = net.createServer(socket => {
    // The client drops connections on purpose (timeouts); that is not an error here.
    socket.on('error', () => undefined);
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      // Commands are arrays of bulk strings; a whole one ends with its last \r\n.
      for (;;) {
        const match = /^\*(\d+)\r\n/.exec(buffer);
        if (!match) return;
        let cursor = match[0].length;
        const parts = [];
        for (let index = 0; index < Number(match[1]); index++) {
          const header = /^\$(\d+)\r\n/.exec(buffer.slice(cursor));
          if (!header) return;
          const start = cursor + header[0].length;
          const length = Number(header[1]);
          if (buffer.length < start + length + 2) return;
          parts.push(buffer.slice(start, start + length));
          cursor = start + length + 2;
        }
        buffer = buffer.slice(cursor);
        received.push(parts);
        const reply = answer(parts);
        if (reply !== undefined) socket.write(reply);
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, received, url: (auth = '') => `redis://${auth}127.0.0.1:${server.address().port}` };
}

test('authenticates first, then sends commands and reads every reply type', async () => {
  const redis = await fakeRedis(([command]) => ({
    AUTH: '+OK\r\n',
    GET: '$4\r\n0.05\r\n',
    INCRBYFLOAT: '$5\r\n0.081\r\n',
    EXPIRE: ':1\r\n',
    MISSING: '$-1\r\n',
  })[command]);
  const client = new RedisClient(redis.url(':s3cr%40t@'));
  try {
    assert.equal(await client.send('GET', ['k']), '0.05');
    assert.equal(await client.send('INCRBYFLOAT', ['k', '0.031000']), '0.081');
    assert.equal(await client.send('EXPIRE', ['k', '172800']), 1);
    assert.equal(await client.send('MISSING', []), null);
    // The password is URL-decoded and sent before anything else.
    assert.deepEqual(redis.received[0], ['AUTH', 's3cr@t']);
    assert.deepEqual(redis.received[2], ['INCRBYFLOAT', 'k', '0.031000']);
  } finally {
    client.close();
    redis.server.close();
  }
});

test('a Redis error rejects that command only', async () => {
  const redis = await fakeRedis(([command]) => command === 'BAD' ? '-ERR unknown command\r\n' : '+PONG\r\n');
  const client = new RedisClient(redis.url());
  try {
    await assert.rejects(client.send('BAD', []), /unknown command/);
    assert.equal(await client.send('PING', []), 'PONG');
  } finally {
    client.close();
    redis.server.close();
  }
});

test('a silent server times out, and the next command reconnects', async () => {
  let silent = true;
  const redis = await fakeRedis(() => silent ? undefined : '+PONG\r\n');
  const client = new RedisClient(redis.url(), { timeoutMs: 100 });
  try {
    await assert.rejects(client.send('PING', []), /redis_timeout/);
    silent = false;
    assert.equal(await client.send('PING', []), 'PONG');
  } finally {
    client.close();
    redis.server.close();
  }
});

test('an unreachable Redis rejects instead of hanging', async () => {
  const closed = net.createServer();
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const port = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  const client = new RedisClient(`redis://127.0.0.1:${port}`, { timeoutMs: 2000 });
  await assert.rejects(client.send('PING', []));
});

test('only redis: and rediss: URLs are accepted', () => {
  assert.throws(() => new RedisClient('http://example.com'), /invalid_redis_url/);
  assert.equal(new RedisClient('rediss://example.com').secure, true);
  assert.equal(new RedisClient('rediss://example.com').port, 6379);
});
