import { describe, expect, it, jest } from '@jest/globals';
import { CacheService } from './cache.service';
import { type CachedNotice } from '../../types/cache.types';
import { APP_CONSTANTS } from '../../config/app.config';

const buildNotice = (num: number): CachedNotice => ({
  num,
  subject: `notice-${num}`,
  proposerCategory: 'member',
  committee: 'committee',
  link: `https://example.com/${num}`,
  contentId: null,
  proposalReason: null,
  attachments: { pdfFile: null, hwpFile: null },
  aiSummary: null,
  aiSummaryStatus: 'not_requested',
});

describe('CacheService statistics snapshot', () => {
  const keys = APP_CONSTANTS.CACHE.KEYS;
  const updatedAt = new Date('2026-10-28T00:00:00.000Z');
  const createCache = (notices: CachedNotice[] = [buildNotice(1)]) => {
    const values = new Map<string, unknown>([
      [keys.RECENT_NOTICES, notices],
      [keys.LAST_UPDATED, updatedAt],
    ]);
    const cache = {
      get: jest.fn(async (key: string) => values.get(key)),
      set: jest.fn(async (key: string, value: unknown) => {
        values.set(key, value);
      }),
      del: jest.fn(async (key: string) => {
        values.delete(key);
      }),
    };
    return { cache, service: new CacheService(cache as any) };
  };

  it('shares one cold payload read across statistics and list requests', async () => {
    const { cache, service } = createCache();
    const results = await Promise.all([
      ...Array.from({ length: 20 }, () => service.getCacheInfo()),
      service.getRecentNotices(10),
    ]);
    expect(results[0]).toMatchObject({
      size: 1,
      lastUpdated: updatedAt,
      isInitialized: true,
    });
    expect(
      cache.get.mock.calls.filter(([key]) => key === keys.RECENT_NOTICES),
    ).toHaveLength(1);
    await service.getCacheInfo();
    expect(
      cache.get.mock.calls.filter(([key]) => key === keys.RECENT_NOTICES),
    ).toHaveLength(1);
  });

  it('keeps empty snapshots cached and refreshes size after updates and clears', async () => {
    const { cache, service } = createCache([]);
    expect((await service.getCacheInfo()).isInitialized).toBe(false);
    expect((await service.getCacheInfo()).size).toBe(0);
    await service.updateCache([buildNotice(2), buildNotice(1)]);
    expect(await service.getCacheInfo()).toMatchObject({
      size: 2,
      isInitialized: true,
    });
    await service.clearCache();
    expect(await service.getCacheInfo()).toMatchObject({
      size: 0,
      isInitialized: false,
      lastUpdated: null,
    });
    expect(
      cache.get.mock.calls.filter(([key]) => key === keys.RECENT_NOTICES),
    ).toHaveLength(2);
  });

  it('retries a failed cold read instead of retaining a rejected load', async () => {
    const { cache, service } = createCache();
    cache.get.mockRejectedValueOnce(new Error('Redis unavailable'));
    expect((await service.getCacheInfo()).size).toBe(0);
    expect((await service.getCacheInfo()).size).toBe(1);
  });

  it.each(['update', 'clear'] as const)(
    'does not restore an old in-flight snapshot after %s',
    async (action) => {
      const { cache, service } = createCache();
      let release!: (value: CachedNotice[]) => void;
      cache.get.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const pending = service.getCacheInfo();
      if (action === 'update') await service.updateCache([buildNotice(2)]);
      else await service.clearCache();
      release([buildNotice(1)]);
      const size = action === 'update' ? 2 : 0;
      expect((await pending).size).toBe(size);
      expect((await service.getCacheInfo()).size).toBe(size);
    },
  );
});

describe('CacheService recent notice snapshot', () => {
  it('reads the serialized Redis payload once and reuses the process snapshot', async () => {
    const get = jest
      .fn<(...args: any[]) => Promise<CachedNotice[]>>()
      .mockResolvedValue([buildNotice(2), buildNotice(1)]);
    const cacheManager = {
      get,
      set: jest.fn<(...args: any[]) => Promise<void>>(),
      del: jest.fn<(...args: any[]) => Promise<void>>(),
    };
    const service = new CacheService(cacheManager as any);

    await expect(service.getRecentNotices(1)).resolves.toEqual([
      buildNotice(2),
    ]);
    await expect(service.getRecentNotices(2)).resolves.toEqual([
      buildNotice(2),
      buildNotice(1),
    ]);

    expect(get).toHaveBeenCalledTimes(1);
  });

  it('refreshes the snapshot after an update without rereading Redis', async () => {
    const get = jest
      .fn<(...args: any[]) => Promise<CachedNotice[]>>()
      .mockResolvedValue([buildNotice(1)]);
    const cacheManager = {
      get,
      set: jest
        .fn<(...args: any[]) => Promise<void>>()
        .mockResolvedValue(undefined),
      del: jest.fn<(...args: any[]) => Promise<void>>(),
    };
    const service = new CacheService(cacheManager as any);

    await service.getRecentNotices(10);
    await service.updateCache([buildNotice(2)]);

    await expect(service.getRecentNotices(10)).resolves.toEqual([
      buildNotice(2),
      buildNotice(1),
    ]);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
