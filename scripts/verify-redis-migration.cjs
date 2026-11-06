const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { createClient } = require('@keyv/redis');
const { createCache } = require('cache-manager');
const { createRedisCacheStore } = require('../dist/modules/cache/cache-keyv.util');

async function main() {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const server = spawn(process.env.REDIS_SERVER || 'redis-server', [
    '--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let store;
  let client;
  try {
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.on('exit', code => reject(new Error(`Redis exited before ready: ${code}`)));
      server.stdout.on('data', data => {
        if (String(data).includes('Ready to accept connections')) resolve();
      });
    });
    const url = `redis://127.0.0.1:${port}`;
    client = createClient({ url });
    await client.connect();
    const namespace = 'lawcast-migration:';
    const prefix = `${namespace}::`;
    // This is the Keyv 5 JSON envelope and Redis 5 adapter key format.
    await client.set(`${prefix}legacy`, JSON.stringify({ value: { schema: 5 }, expires: null }));
    await client.set('unrelated', 'preserve');
    store = createRedisCacheStore(url, namespace);
    const cache = createCache({ stores: [store] });
    assert.deepEqual(await cache.get('legacy'), { schema: 5 });
    await cache.set('round-trip', { schema: 6 }, 10000);
    assert.deepEqual(await cache.get('round-trip'), { schema: 6 });
    const envelope = JSON.parse(await client.get(`${prefix}round-trip`));
    assert.deepEqual(envelope.value, { schema: 6 });
    assert.ok(await client.pTTL(`${prefix}round-trip`) > 0);
    let calls = 0;
    assert.equal(await cache.wrap('wrapped', async () => ++calls, 10000), 1);
    assert.equal(await cache.wrap('wrapped', async () => ++calls, 10000), 1);
    await cache.set('expires', 'short', 20);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(await cache.get('expires'), undefined);
    await cache.clear();
    assert.equal(await client.get('unrelated'), 'preserve');
    assert.deepEqual(await client.keys(`${prefix}*`), []);
    console.log('REDIS: legacy envelope, namespace, round-trip, TTL, wrap hit and isolated clear passed');
  } finally {
    await store?.disconnect();
    await client?.quit();
    server.kill('SIGTERM');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
