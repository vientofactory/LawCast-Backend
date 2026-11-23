import { NoticeSitemapService } from './notice-sitemap.service';
import { NoticeSitemapController } from './notice-sitemap.controller';

function setup() {
  const repository = {
    find: jest.fn().mockResolvedValue(
      Array.from({ length: 22740 }, (_, i) => ({
        noticeNum: 2200001 + i,
        archiveStartedAt: new Date('2026-09-01Z'),
      })),
    ),
  };
  const values = new Map();
  const cache = {
    get: jest.fn(async (key) => values.get(key)),
    set: jest.fn(async (key, value) => {
      values.set(key, value);
    }),
  };
  const service = new NoticeSitemapService(repository as never, cache as never);
  return { service, repository, cache, values };
}

describe('Notice sitemap snapshot', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('serves 100 cold readers from one metadata-only query without a visitor quota', async () => {
    const { service, repository, cache } = setup();
    const controller = new NoticeSitemapController(service);
    const responses = await Promise.all(
      Array.from({ length: 100 }, () =>
        controller.getNotices({ setHeader: jest.fn() } as never),
      ),
    );
    expect(
      responses.every((r) => r.total === 22740 && r === responses[0]),
    ).toBe(true);
    expect(repository.find).toHaveBeenCalledTimes(1);
    expect(repository.find).toHaveBeenCalledWith({
      select: { noticeNum: true, archiveStartedAt: true },
      order: { noticeNum: 'ASC' },
    });
    expect(cache.set).toHaveBeenCalledWith(
      'sitemap:notices:v1',
      responses[0],
      0,
    );
  });

  it('reuses the persistent snapshot from a new service instance', async () => {
    const { service, repository, cache } = setup();
    const original = await service.getSnapshot();
    const restarted = new NoticeSitemapService(
      repository as never,
      cache as never,
    );
    expect(await restarted.getSnapshot()).toEqual(original);
    expect(repository.find).toHaveBeenCalledTimes(1);
  });

  it('retains a complete stale snapshot after refresh failure and retries after a cooldown', async () => {
    const { service, repository } = setup();
    jest.useFakeTimers({ now: new Date('2026-11-24T00:00:00Z') });
    const original = await service.getSnapshot();
    jest.setSystemTime(Date.now() + 3600001);
    repository.find.mockRejectedValue(new Error('database unavailable'));
    expect(await service.getSnapshot()).toEqual(original);
    expect(await service.getSnapshot()).toEqual(original);
    expect(repository.find).toHaveBeenCalledTimes(2);
    jest.setSystemTime(Date.now() + 24 * 3600000);
    await expect(service.getSnapshot()).rejects.toMatchObject({ status: 503 });
  });

  it('does not publish invalid or partial data over the last good snapshot', async () => {
    const { service, repository } = setup();
    jest.useFakeTimers({ now: new Date('2026-11-24T00:00:00Z') });
    const original = await service.getSnapshot();
    jest.setSystemTime(Date.now() + 3600001);
    repository.find.mockResolvedValue([{ noticeNum: -1 }]);
    expect(await service.getSnapshot()).toEqual(original);
  });

  it('fails closed without a last good generation and recovers on the next request', async () => {
    const { service, repository } = setup();
    repository.find.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.getSnapshot()).rejects.toMatchObject({ status: 503 });
    expect((await service.getSnapshot()).total).toBe(22740);
  });

  it('tolerates cache outages and serves a valid empty archive', async () => {
    const { service, repository, cache } = setup();
    repository.find.mockResolvedValue([]);
    cache.get.mockRejectedValue(new Error('redis unavailable'));
    cache.set.mockRejectedValue(new Error('redis unavailable'));
    expect((await service.getSnapshot()).items).toEqual([]);
    expect((await service.getSnapshot()).total).toBe(0);
  });
});
