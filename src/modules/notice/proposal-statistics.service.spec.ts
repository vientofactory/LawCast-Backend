import { ProposalStatisticsService } from './proposal-statistics.service';

describe('Proposal statistics concurrent cache misses', () => {
  function setup() {
    const builder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest
        .fn()
        .mockResolvedValue([{ period: '2026-10', count: '3' }]),
    };
    const repository = { createQueryBuilder: jest.fn(() => builder) };
    const cache = {
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn(),
    };
    const service = new ProposalStatisticsService(
      repository as never,
      cache as never,
    );
    return { service, builder, repository, cache };
  }

  it('shares one cold aggregation while keeping filter keys independent', async () => {
    const { service, repository, cache } = setup();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.getProposalStatistics({ granularity: 'monthly' }),
      ),
    );
    expect(results.every((result) => result.totalCount === 3)).toBe(true);
    expect(repository.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith(
      'proposal-stats:monthly::',
      results[0],
      300000,
    );
    await Promise.all([
      service.getProposalStatistics({ granularity: 'daily' }),
      service.getProposalStatistics({
        granularity: 'monthly',
        startDate: '2026-10-01',
      }),
    ]);
    expect(repository.createQueryBuilder).toHaveBeenCalledTimes(3);
  });

  it('recovers from a failed shared read and honors later cache hits', async () => {
    const { service, builder, repository, cache } = setup();
    builder.getRawMany.mockRejectedValueOnce(new Error('busy'));
    const failed = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        service.getProposalStatistics({ granularity: 'monthly' }),
      ),
    );
    expect(failed.every((result) => result.status === 'rejected')).toBe(true);
    const result = await service.getProposalStatistics({
      granularity: 'monthly',
    });
    expect(result.totalCount).toBe(3);
    cache.get.mockResolvedValueOnce({ ...result, totalCount: 9 });
    expect(
      (await service.getProposalStatistics({ granularity: 'monthly' }))
        .totalCount,
    ).toBe(9);
    expect(repository.createQueryBuilder).toHaveBeenCalledTimes(2);
  });
});
