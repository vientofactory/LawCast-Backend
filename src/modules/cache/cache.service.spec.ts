import { describe, expect, it, jest } from '@jest/globals';
import { CacheService } from './cache.service';
import { type CachedNotice } from '../../types/cache.types';

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
