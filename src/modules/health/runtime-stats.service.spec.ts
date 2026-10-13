import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { RuntimeStatsService } from './runtime-stats.service';

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

function buildService(params?: {
  palPhaseFailed?: boolean;
  isProcessing?: boolean;
}) {
  const cacheManager = { get: jest.fn(), set: jest.fn() } as any;
  const archiveRepo = {} as any;
  const changeEventRepo = {} as any;
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
