import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { RuntimeStatsService } from './runtime-stats.service';
import { NSM_LIST_SCAN_HEALTH_CACHE_KEY } from '../crawling/utils/nsm-list-scan-health.util';

const CRAWLER_STATUS_CASES = [
  {
    label: 'both crawlers enabled by default',
    env: {},
    expected: { pal: true, nsm: true },
  },
  {
    label: 'PAL disabled',
    env: { CRAWLING_PAL_ENABLED: 'false' },
    expected: { pal: false, nsm: true },
  },
  {
    label: 'NSM disabled',
    env: { CRAWLING_NSM_ENABLED: '0' },
    expected: { pal: true, nsm: false },
  },
  {
    label: 'both disabled',
    env: { CRAWLING_PAL_ENABLED: 'off', CRAWLING_NSM_ENABLED: 'no' },
    expected: { pal: false, nsm: false },
  },
] as const;

/** Minimal chainable TypeORM query-builder double for the transparency aggregations. */
function createQueryBuilderStub(
  rawRows: Array<Record<string, unknown>> = [],
  countValue = 0,
) {
  const qb: any = {
    select: jest.fn(() => qb),
    addSelect: jest.fn(() => qb),
    groupBy: jest.fn(() => qb),
    where: jest.fn(() => qb),
    getRawMany: jest.fn(async () => rawRows),
    getCount: jest.fn(async () => countValue),
  };
  return qb;
}

/**
 * The subset of the transparency payload these tests assert on.
 * `getTransparencyStats()` widens its cached branch to `Record<string, unknown>`,
 * so the test narrows the parts it inspects instead of reaching for `any`.
 */
type TransparencyPayload = {
  noticeSources: Array<{ id: string; name: string; url: string }>;
  schedules: Array<{ id: string; name: string }>;
  transferFlow: { description: string };
};

function buildService(params?: {
  palPhaseFailed?: boolean;
  isProcessing?: boolean;
  nsmListScanHealth?: unknown;
}) {
  const cacheManager = {
    get: jest.fn(async (key: string) =>
      key === NSM_LIST_SCAN_HEALTH_CACHE_KEY
        ? (params?.nsmListScanHealth ?? undefined)
        : undefined,
    ),
    set: jest.fn(),
  } as any;
  const archiveRepo = {
    count: jest.fn(async () => 0),
    createQueryBuilder: jest.fn(() => createQueryBuilderStub()),
  } as any;
  const changeEventRepo = {
    createQueryBuilder: jest.fn(() => createQueryBuilderStub()),
  } as any;
  const service = new RuntimeStatsService(
    cacheManager,
    archiveRepo,
    changeEventRepo,
  );

  const webhookService = {
    getDetailedStatsForApi: jest
      .fn<() => Promise<any>>()
      .mockResolvedValue({ total: 0, active: 0, inactive: 0, efficiency: 0 }),
  } as any;
  const crawlingService = {
    getCacheInfo: jest.fn<() => Promise<any>>().mockResolvedValue({
      size: 0,
      lastUpdated: null,
      maxSize: 10,
      isInitialized: true,
    }),
    getOllamaMetrics: jest.fn<() => Promise<any>>().mockResolvedValue({
      enabled: false,
      configured: false,
      model: null,
      summary: { total: 0, success: 0, failed: 0, skipped: 0, successRate: 0 },
      health: { status: 'unknown', lastCheckedAt: null, lastLatencyMs: null },
    }),
    getSchedulerExecutionState: jest
      .fn<(...args: any[]) => any>()
      .mockReturnValue({
        isProcessing: params?.isProcessing ?? false,
        isPendingProcessing: false,
        lastPalCronRunAt: null,
        lastNsmPendingCronRunAt: null,
      }),
  } as any;
  const noticeArchiveService = {
    getArchiveCount: jest.fn<() => Promise<any>>().mockResolvedValue(0),
  } as any;
  const archiveSyncService = {
    getIsDoneSyncStatus: jest
      .fn<(...args: any[]) => any>()
      .mockReturnValue(null),
    getLegacyGenesisSeedStatus: jest
      .fn<(...args: any[]) => any>()
      .mockReturnValue(null),
    getExecutionState: jest.fn<(...args: any[]) => any>().mockReturnValue({
      isAnyPhaseRunning: false,
      runningPhases: [],
      phases: params?.palPhaseFailed
        ? [
            {
              name: 'full sync',
              status: 'failed',
              lastRunAt: '2026-01-01T00:00:00.000Z',
              lastError: 'previous failure',
            },
          ]
        : [],
      asyncApply: null,
    }),
  } as any;
  const changeTrackingService = {
    getComparableChangeSummary: jest
      .fn<() => Promise<any>>()
      .mockResolvedValue({}),
  } as any;
  const webPushSubscriptionService = {
    getStatsForApi: jest
      .fn<() => Promise<any>>()
      .mockResolvedValue({ total: 0, active: 0, inactive: 0, withFailures: 0 }),
  } as any;
  const cronJobsService = {
    getCronJobsStatus: jest.fn<(...args: any[]) => any>().mockReturnValue([]),
    getCronJobExpression: jest
      .fn<(...args: any[]) => any>()
      .mockReturnValue(undefined),
  } as any;

  return {
    service,
    getTransparency: () => service.getTransparencyStats(),
    getStats: () =>
      service.getAggregatedStats(
        { nodeEnv: 'production' },
        webhookService,
        crawlingService,
        noticeArchiveService,
        archiveSyncService,
        changeTrackingService,
        webPushSubscriptionService,
        cronJobsService,
      ),
  };
}

describe('RuntimeStatsService crawler activation', () => {
  afterEach(() => {
    delete process.env.CRAWLING_PAL_ENABLED;
    delete process.env.CRAWLING_NSM_ENABLED;
  });

  it.each(CRAWLER_STATUS_CASES)(
    'reports enabled=$expected.pal/$expected.nsm when $label',
    async ({ env, expected }) => {
      Object.assign(process.env, env);
      const { getStats } = buildService();

      const stats = await getStats();

      expect(stats.crawlers.palCrawler.enabled).toBe(expected.pal);
      expect(stats.crawlers.nsmPendingCrawler.enabled).toBe(expected.nsm);
    },
  );

  it('keeps the schedule metadata of a disabled crawler so the UI can still show it', async () => {
    process.env.CRAWLING_PAL_ENABLED = 'false';
    const { getStats } = buildService();

    const stats = await getStats();

    expect(stats.crawlers.palCrawler.enabled).toBe(false);
    expect(stats.crawlers.palCrawler.source).toBe('pal.assembly.go.kr');
    expect(stats.crawlers.palCrawler.cron.intervalMs).toBe(600_000);
    expect(stats.crawlers.palCrawler.cron.expression).toBeTruthy();
  });

  it('reads the flags on every aggregation so a runtime toggle is reflected', async () => {
    const { getStats } = buildService();

    expect((await getStats()).crawlers.palCrawler.enabled).toBe(true);

    process.env.CRAWLING_PAL_ENABLED = 'false';
    expect((await getStats()).crawlers.palCrawler.enabled).toBe(false);

    process.env.CRAWLING_PAL_ENABLED = 'true';
    expect((await getStats()).crawlers.palCrawler.enabled).toBe(true);
  });

  it('can carry a stale failure from before the crawler was disabled', async () => {
    // The raw `status`/`lastError` pair outlives the activation gate: a crawler
    // disabled after a failed run still reports that failure. Consumers must key
    // off `enabled` before treating the crawler as broken.
    process.env.CRAWLING_PAL_ENABLED = 'false';
    const { getStats } = buildService({ palPhaseFailed: true });

    const stats = await getStats();

    expect(stats.crawlers.palCrawler.enabled).toBe(false);
    expect(stats.crawlers.palCrawler.status).toBe('failed');
    expect(stats.crawlers.palCrawler.lastError).toBe('previous failure');
  });

  it('reports a running crawler whose gate is enabled', async () => {
    const { getStats } = buildService({ isProcessing: true });

    const stats = await getStats();

    expect(stats.crawlers.palCrawler.enabled).toBe(true);
    expect(stats.crawlers.palCrawler.status).toBe('running');
  });
});

describe('RuntimeStatsService NSM list scan health', () => {
  const degradedHealth = {
    source: 'nsm',
    lastScanAt: '2026-10-14T00:50:00.000Z',
    lastScanItemCount: 0,
    lastSuccessfulScanAt: '2026-10-13T21:50:00.000Z',
    lastSuccessfulScanItemCount: 15203,
    consecutiveZeroRowScans: 3,
    degraded: true,
    degradedSince: '2026-10-14T00:50:00.000Z',
    lastAlertAt: '2026-10-14T00:50:00.000Z',
  };

  it('reports an unknown list-scan state instead of a fake healthy one', async () => {
    const { getStats } = buildService();

    const stats = await getStats();

    expect(stats.crawlers.nsmPendingCrawler.status).toBe('idle');
    expect(stats.crawlers.nsmPendingCrawler.listScan).toEqual({
      degraded: false,
      consecutiveZeroRowScans: 0,
      lastScanAt: null,
      lastScanItemCount: null,
      lastSuccessfulScanAt: null,
      lastSuccessfulScanItemCount: null,
      degradedSince: null,
      staleHours: null,
      description: null,
    });
  });

  it('marks the collector degraded when the list has served zero rows for consecutive scans', async () => {
    const { getStats } = buildService({
      nsmListScanHealth: degradedHealth,
    });

    const stats = await getStats();
    const nsm = stats.crawlers.nsmPendingCrawler;

    // A run that completes while reading nothing must not look idle: the
    // degraded state is what the status page escalates on.
    expect(nsm.status).toBe('degraded');
    expect(nsm.listScan.degraded).toBe(true);
    expect(nsm.listScan.consecutiveZeroRowScans).toBe(3);
    expect(nsm.listScan.lastSuccessfulScanAt).toBe('2026-10-13T21:50:00.000Z');
    expect(nsm.listScan.lastScanItemCount).toBe(0);
    expect(nsm.listScan.staleHours).toBeGreaterThan(0);
    expect(nsm.listScan.description).toContain(
      'last list scan that returned rows',
    );
  });
});

describe('RuntimeStatsService NSM source reporting', () => {
  afterEach(() => {
    delete process.env.CRAWLING_NSM_SOURCE;
  });

  it('reports the public-participation portal by default', async () => {
    const { getStats, getTransparency } = buildService();

    const stats = await getStats();
    expect(stats.crawlers.nsmPendingCrawler.source).toBe(
      'opinion.lawmaking.go.kr',
    );
    expect(stats.crawlers.nsmPendingCrawler.name).toBe(
      '국민참여입법센터 입법진행현황 크롤러',
    );

    const transparency = (await getTransparency()) as TransparencyPayload;
    const nsmSource = transparency.noticeSources.find(
      (source) => source.id === 'nsm',
    );
    expect(nsmSource?.url).toBe('https://opinion.lawmaking.go.kr');
    expect(nsmSource?.name).toBe('국민참여입법센터 입법진행현황');

    const nsmSchedule = transparency.schedules.find(
      (schedule) => schedule.id === 'nsm-pending',
    );
    expect(nsmSchedule?.name).toBe('국민참여입법센터 입법진행현황 수집');
    expect(transparency.transferFlow.description).toContain('국민참여입법센터');
  });

  it('reports the National Assembly Bill Information System under CRAWLING_NSM_SOURCE=likms', async () => {
    process.env.CRAWLING_NSM_SOURCE = 'likms';
    const { getStats, getTransparency } = buildService();

    const stats = await getStats();
    expect(stats.crawlers.nsmPendingCrawler.source).toBe(
      'likms.assembly.go.kr',
    );
    expect(stats.crawlers.nsmPendingCrawler.name).toContain('의안정보시스템');

    const transparency = (await getTransparency()) as TransparencyPayload;
    const nsmSource = transparency.noticeSources.find(
      (source) => source.id === 'nsm',
    );
    expect(nsmSource?.url).toBe('https://likms.assembly.go.kr');
    expect(nsmSource?.name).toBe('국회 의안정보시스템 계류의안');

    const nsmSchedule = transparency.schedules.find(
      (schedule) => schedule.id === 'nsm-pending',
    );
    expect(nsmSchedule?.name).toBe('국회 의안정보시스템 계류의안 수집');
    expect(transparency.transferFlow.description).toContain('계류의안');
  });

  it('reads the source on every aggregation so a runtime switch is reflected', async () => {
    const { getStats } = buildService();

    expect((await getStats()).crawlers.nsmPendingCrawler.source).toBe(
      'opinion.lawmaking.go.kr',
    );

    process.env.CRAWLING_NSM_SOURCE = 'likms';
    expect((await getStats()).crawlers.nsmPendingCrawler.source).toBe(
      'likms.assembly.go.kr',
    );
  });
});
