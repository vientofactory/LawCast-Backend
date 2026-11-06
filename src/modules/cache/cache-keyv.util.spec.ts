import { createCache } from 'cache-manager';
import { CacheModule, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Test } from '@nestjs/testing';
import Keyv, { KeyvMemoryAdapter } from 'keyv';
import { adaptKeyv6Store } from './cache-keyv.util';

describe('Keyv 6 cache-manager compatibility', () => {
  it('returns cache misses rather than throwing when an adapter fails', async () => {
    const adapter = new KeyvMemoryAdapter(new Map());
    adapter.get = jest.fn().mockRejectedValue(new Error('fixture outage'));
    const store = adaptKeyv6Store(new Keyv({ store: adapter }));
    await expect(store.get('missing')).resolves.toBeUndefined();
  });
  it('preserves Nest store identity and raw wrap reads without double serialization', async () => {
    const store = adaptKeyv6Store(new Keyv());
    const module = await Test.createTestingModule({
      imports: [CacheModule.register({ stores: [store] })],
    }).compile();
    const cache = module.get<ReturnType<typeof createCache>>(CACHE_MANAGER);
    const loader = jest.fn().mockResolvedValue({ value: 'fixture' });
    try {
      expect(cache.stores[0]).toBe(store);
      expect(await cache.wrap('wrapped', loader, 10000)).toEqual({
        value: 'fixture',
      });
      expect(await cache.wrap('wrapped', loader, 10000)).toEqual({
        value: 'fixture',
      });
      expect(loader).toHaveBeenCalledTimes(1);
      expect(await cache.get('wrapped')).toEqual({ value: 'fixture' });
      expect(await cache.ttl('wrapped')).toBeGreaterThan(Date.now());
      await cache.mset([{ key: 'batch', value: 3, ttl: 10000 }]);
      expect(await cache.mget(['batch', 'absent'])).toEqual([3, undefined]);
      await cache.del('wrapped');
      expect(await cache.get('wrapped')).toBeUndefined();
    } finally {
      await module.close();
    }
  });
});
