/**
 * HTTP 처리와 배치 처리 간 격리 검증 테스트
 *
 * 이 테스트는 실제 API 컨트롤러가 배치 처리 중에도 정상적으로 HTTP 요청을 처리하는지 검증합니다.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ApiController } from '../controllers/api.controller';
import { BatchProcessingService } from '../modules/shared/batch-processing.service';
import { CrawlingService } from '../modules/crawling/crawling.service';
import { WebhookService } from '../modules/webhook/webhook.service';
import { ChangeTrackingService } from '../modules/change-tracking/change-tracking.service';
import { WebhookRegistrationService } from '../modules/notification/webhook-registration.service';
import { WebPushSubscriptionService } from '../modules/notification/web-push-subscription.service';
import { WebPushNotificationService } from '../modules/notification/web-push-notification.service';
import { WebPushRegistrationService } from '../modules/notification/web-push-registration.service';
import { WebhookCleanupService } from '../modules/webhook/webhook-cleanup.service';
import { NoticeArchiveService } from '../modules/notice/notice-archive.service';
import { NoticesQueryService } from '../modules/crawling/notices-query.service';
import { NotificationBatchService } from '../modules/notification/notification-batch.service';
import { HealthCheckService } from '../modules/health/health-check.service';
import { RuntimeStatsService } from '../modules/health/runtime-stats.service';
import { NoticeSearchService } from '../modules/crawling/notice-search.service';
import { ArchiveSyncService } from '../modules/crawling/archive-sync.service';
import { PackagesService } from '../modules/shared/packages.service';
import { CronJobsService } from '../modules/scheduling/cronjobs.service';
import { ApiReadRateLimitService } from '../modules/shared/api-read-rate-limit.service';
import { IpMaskingUtil } from '../modules/discussions/utils/ip-masking.util';

describe('HTTP-Batch Processing Isolation', () => {
  let controller: ApiController;
  let batchService: BatchProcessingService;
  let notificationBatchService: NotificationBatchService;
  let module: TestingModule;

  beforeEach(async () => {
    const mockWebhookService = {
      findAll: jest.fn().mockResolvedValue([]),
      removeFailedWebhooks: jest.fn(),
      getDetailedStats: jest.fn().mockResolvedValue({
        total: 100,
        active: 75,
        inactive: 25,
        oldInactive: 5,
        recentInactive: 20,
        efficiency: 75,
      }),
    };

    const mockCrawlingService = {
      getRecentNotices: jest.fn().mockReturnValue([
        {
          num: 1,
          subject: 'Test Notice',
          proposerCategory: 'Government',
          committee: 'Justice',
          numComments: 5,
          link: 'http://test.com/1',
        },
      ]),
      getCacheInfo: jest.fn().mockReturnValue({
        size: 10,
        lastUpdated: new Date(),
        maxSize: 50,
        isInitialized: true,
      }),
      getApiHealthPayload: jest.fn().mockResolvedValue({
        status: 'healthy',
        services: {
          redis: { status: 'connected' },
          ollama: { status: 'ready', model: 'gemma3:1b' },
        },
      }),
      isRedisConnected: jest.fn().mockReturnValue(true),
      isAiSummaryEnabled: jest.fn().mockReturnValue(true),
      getOllamaMetrics: jest.fn().mockResolvedValue({
        enabled: true,
        configured: true,
        model: 'gemma3:1b',
        summary: {
          total: 10,
          success: 9,
          failed: 1,
          skipped: 0,
          successRate: 90,
          lastLatencyMs: 120,
          lastSuccessAt: new Date().toISOString(),
          lastFailureAt: null,
          lastError: null,
        },
        health: {
          status: 'healthy',
          lastCheckedAt: new Date().toISOString(),
          lastLatencyMs: 50,
          availableModelCount: 1,
          error: null,
        },
      }),
    };

    const mockHealthCheckService = {
      getApiHealthPayload: jest.fn().mockResolvedValue({ status: 'healthy' }),
    };

    const mockWebhookCleanupService = {
      intelligentWebhookCleanup: jest.fn().mockResolvedValue(undefined),
      weeklySystemOptimization: jest.fn().mockResolvedValue(undefined),
      realTimeSystemMonitoring: jest.fn().mockResolvedValue(undefined),
      performSelfDiagnostics: jest.fn().mockResolvedValue({
        systemHealth: 'excellent',
        autoActionsPerformed: [],
      }),
    };

    const mockNoticeArchiveService = {
      getArchiveNotices: jest.fn().mockResolvedValue({
        items: [],
        page: 1,
        limit: 10,
        total: 0,
        totalPages: 1,
        search: '',
      }),
      getArchivedNoticeDetail: jest.fn().mockResolvedValue(null),
      getArchiveCount: jest.fn().mockResolvedValue(0),
    };

    const mockRuntimeStatsService = {
      getRuntimeStats: jest.fn().mockResolvedValue({
        uptime: 3600,
        memoryUsage: { rss: 1000000, heapTotal: 500000, heapUsed: 300000 },
        activeConnections: 5,
        requestCount: 100,
      }),
      getAggregatedStats: jest.fn().mockResolvedValue({
        webhooks: {
          total: 100,
          active: 75,
          inactive: 25,
          oldInactive: 5,
          recentInactive: 20,
          efficiency: 75,
        },
        cache: {
          size: 10,
          lastUpdated: new Date(),
          maxSize: 50,
          isInitialized: true,
        },
        archive: {
          count: 100,
        },
        batchProcessing: {
          jobCount: 0,
          jobIds: [],
        },
        ollama: {
          enabled: true,
          configured: true,
          model: 'gemma3:1b',
          summary: {
            total: 10,
            success: 8,
            failed: 1,
            skipped: 1,
            successRate: 80,
          },
          health: {
            status: 'ready',
            lastCheckedAt: new Date().toISOString(),
          },
        },
      }),
    };

    const mockNoticesQueryService = {
      getArchivedNotices: jest.fn().mockResolvedValue({
        items: [],
        page: 1,
        limit: 10,
        total: 0,
        totalPages: 1,
        search: '',
        stats: {
          cacheCount: 0,
          matchedCacheCount: 0,
          archiveCount: 0,
          totalArchiveCount: 0,
          mergedCount: 0,
        },
      }),
    };

    const mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'nodeEnv') {
          return 'development';
        }
        return undefined;
      }),
    };

    const mockNotificationBatchService = {
      processNotificationBatch: jest.fn().mockResolvedValue('job-123'),
      executeNotificationBatch: jest.fn().mockResolvedValue([
        { success: true, data: 'result1' },
        { success: true, data: 'result2' },
        { success: true, data: 'result3' },
      ]),
    };

    module = await Test.createTestingModule({
      controllers: [ApiController],
      providers: [
        BatchProcessingService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: WebhookService, useValue: mockWebhookService },
        { provide: CrawlingService, useValue: mockCrawlingService },
        {
          provide: WebhookRegistrationService,
          useValue: {
            registerWebhook: jest.fn(),
          },
        },
        {
          provide: WebPushRegistrationService,
          useValue: {
            registerSubscription: jest.fn(),
            unregisterSubscription: jest.fn(),
          },
        },
        {
          provide: WebPushSubscriptionService,
          useValue: {
            createOrReactivate: jest.fn(),
            deleteByEndpoint: jest.fn(),
            isEndpointBoundToDiscussion: jest.fn().mockResolvedValue(false),
            deactivateDiscussionBinding: jest.fn(),
            getStatsForApi: jest.fn().mockResolvedValue({
              total: 3,
              active: 2,
              inactive: 1,
              withFailures: 1,
            }),
          },
        },
        {
          provide: WebPushNotificationService,
          useValue: {
            getPublicConfig: jest.fn().mockReturnValue({
              enabled: true,
              publicKey: 'mock-public-key',
            }),
          },
        },
        { provide: HealthCheckService, useValue: mockHealthCheckService },
        { provide: WebhookCleanupService, useValue: mockWebhookCleanupService },
        { provide: NoticeArchiveService, useValue: mockNoticeArchiveService },
        { provide: NoticesQueryService, useValue: mockNoticesQueryService },
        {
          provide: NoticeSearchService,
          useValue: {
            searchNotices: jest.fn().mockResolvedValue({ items: [], total: 0 }),
          },
        },
        {
          provide: ArchiveSyncService,
          useValue: {
            getIsDoneSyncStatus: jest.fn().mockReturnValue({
              status: 'idle',
              lastRunAt: null,
              lastResult: null,
              lastError: null,
            }),
          },
        },
        {
          provide: ChangeTrackingService,
          useValue: {
            getNoticeChangeTimeline: jest.fn().mockResolvedValue([]),
            getRecentChanges: jest.fn().mockResolvedValue({
              items: [],
              page: 1,
              limit: 10,
              total: 0,
              totalPages: 0,
            }),
          },
        },
        {
          provide: PackagesService,
          useValue: {
            getPackages: jest.fn().mockReturnValue([]),
            getVersion: jest
              .fn()
              .mockReturnValue({ version: '0.0.1', buildEnv: 'test' }),
          },
        },
        {
          provide: NotificationBatchService,
          useValue: mockNotificationBatchService,
        },
        { provide: RuntimeStatsService, useValue: mockRuntimeStatsService },
        {
          provide: CronJobsService,
          useValue: {
            getCronJobsStatus: jest.fn().mockReturnValue([]),
            getCronJobExpression: jest.fn().mockReturnValue(undefined),
          },
        },
        {
          provide: ApiReadRateLimitService,
          useValue: { assertAllowed: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get<ApiController>(ApiController);
    batchService = module.get<BatchProcessingService>(BatchProcessingService);
    notificationBatchService = module.get<NotificationBatchService>(
      NotificationBatchService,
    );
  });

  afterEach(async () => {
    await batchService.waitForAllBatchJobs();
    batchService.clearAllTimeouts();
    if (module) {
      await module.close();
    }
  });

  describe('Discussion web push authorId derivation', () => {
    beforeAll(() => {
      process.env.DISCUSSION_AUTHOR_ID_SECRET = 'test-author-id-secret';
    });

    it('checks status using the proxy-forwarded client IP, not the raw socket IP', async () => {
      const webPushSubscriptionService = module.get<WebPushSubscriptionService>(
        WebPushSubscriptionService,
      );

      await controller.getDiscussionWebPushStatus(
        42,
        'https://push.example/subscription/1',
        {
          headers: { 'cf-connecting-ip': '203.0.113.10' },
          ip: '10.0.0.5',
        } as any,
      );

      const expectedAuthorId = IpMaskingUtil.authorIdFromIp(
        '203.0.113.10',
        'thread:42',
      );
      expect(
        webPushSubscriptionService.isEndpointBoundToDiscussion,
      ).toHaveBeenCalledWith(
        'https://push.example/subscription/1',
        42,
        expectedAuthorId,
      );
    });

    it('removes the binding using the proxy-forwarded client IP, not the raw socket IP', async () => {
      const webPushSubscriptionService = module.get<WebPushSubscriptionService>(
        WebPushSubscriptionService,
      );

      await controller.removeDiscussionWebPushBinding(
        42,
        { endpoint: 'https://push.example/subscription/1' },
        {
          headers: { 'cf-connecting-ip': '203.0.113.10' },
          ip: '10.0.0.5',
        } as any,
      );

      const expectedAuthorId = IpMaskingUtil.authorIdFromIp(
        '203.0.113.10',
        'thread:42',
      );
      expect(
        webPushSubscriptionService.deactivateDiscussionBinding,
      ).toHaveBeenCalledWith(
        'https://push.example/subscription/1',
        42,
        expectedAuthorId,
      );
    });
  });

  describe('API Responsiveness During Batch Processing', () => {
    it('should handle health checks instantly even during batch processing', async () => {
      // 1. Start long-running batch jobs
      const longRunningJobs = Array.from(
        { length: 10 },
        (_, i) => () =>
          new Promise((resolve) => setTimeout(() => resolve(`job-${i}`), 100)),
      );

      // Start batch processing (runs in background)
      const batchPromise = batchService.executeBatch(longRunningJobs, {
        concurrency: 3,
      });

      // 2. Handle HTTP requests during batch processing
      const healthRequests = Array.from({ length: 20 }, async () => {
        const startTime = Date.now();
        const response = await controller.getHealth();
        const responseTime = Date.now() - startTime;

        expect(response).toBeDefined();
        expect(response.success).toBe(true);

        return responseTime;
      });

      const responseTimes = await Promise.all(healthRequests);
      const maxResponseTime = Math.max(...responseTimes);
      const avgResponseTime =
        responseTimes.reduce((sum, time) => sum + time, 0) /
        responseTimes.length;

      // 3. Wait for batch jobs to complete
      const batchResults = await batchPromise;

      expect(batchResults.every((r) => r.success)).toBe(true);
      // Loaded CI runners can have occasional spikes, but health checks should
      // still remain responsive overall during background batch processing.
      expect(maxResponseTime).toBeLessThan(100);
      expect(avgResponseTime).toBeLessThan(20);

      console.log(
        `Health API: avg ${avgResponseTime.toFixed(2)}ms, max ${maxResponseTime}ms during batch processing`,
      );
    });

    it('should serve recent notices quickly regardless of batch operations', async () => {
      // 1. Start notification batch processing (non-blocking)
      const mockNotices = Array.from({ length: 5 }, (_, i) => ({
        subject: `Notice ${i}`,
        proposerCategory: 'Test',
        committee: 'Test',
        numComments: 0,
        link: `http://test.com/${i}`,
      }));

      await notificationBatchService.processNotificationBatch(
        mockNotices as any,
      );

      // 2. Query recent notices from multiple clients concurrently
      const noticeRequests = Array.from({ length: 50 }, async () => {
        const startTime = Date.now();
        const response = await controller.getRecentNotices();
        const responseTime = Date.now() - startTime;

        expect(response).toBeDefined();
        expect(response.success).toBe(true);
        expect(Array.isArray(response.data)).toBe(true);
        expect(responseTime).toBeLessThanOrEqual(15); // Respond within 15ms (with margin)

        return responseTime;
      });

      const responseTimes = await Promise.all(noticeRequests);
      const maxResponseTime = Math.max(...responseTimes);

      expect(maxResponseTime).toBeLessThanOrEqual(15); // Max within 15ms (with margin)

      console.log(
        `Recent notices API: max response time ${maxResponseTime}ms (50 concurrent requests)`,
      );
    });

    it('should provide batch status without performance degradation', async () => {
      // 1. Start batch jobs of various sizes
      const smallBatch = batchService.executeBatch([
        () => new Promise((resolve) => setTimeout(() => resolve('small'), 50)),
      ]);

      const mediumBatch = batchService.executeBatch(
        Array.from(
          { length: 5 },
          () => () =>
            new Promise((resolve) => setTimeout(() => resolve('medium'), 100)),
        ),
        { concurrency: 2 },
      );

      const largeBatch = batchService.executeBatch(
        Array.from(
          { length: 20 },
          () => () =>
            new Promise((resolve) => setTimeout(() => resolve('large'), 200)),
        ),
        { concurrency: 5 },
      );

      // 2. Query status while batch jobs are running
      const statusRequests = Array.from({ length: 100 }, async () => {
        const startTime = Date.now();
        const response = await controller.getBatchStatus();
        const responseTime = Date.now() - startTime;

        expect(response).toBeDefined();
        expect(response.success).toBe(true);
        expect(typeof response.data.jobCount).toBe('number');
        expect(Array.isArray(response.data.jobIds)).toBe(true);

        return { responseTime, jobCount: response.data.jobCount };
      });

      const results = await Promise.all(statusRequests);

      // 3. Wait for all batch jobs to complete
      await Promise.all([smallBatch, mediumBatch, largeBatch]);

      const avgResponseTime =
        results.reduce((sum, r) => sum + r.responseTime, 0) / results.length;

      expect(avgResponseTime).toBeLessThan(20); // Average within 20ms (environment variance allowed)

      console.log(
        `Batch status API: avg response time ${avgResponseTime.toFixed(2)}ms`,
      );
    });

    it('should handle stats API efficiently during heavy batch load', async () => {
      // 1. Start a large number of batch jobs
      const heavyBatchPromises = Array.from({ length: 5 }, () =>
        batchService.executeBatch(
          Array.from(
            { length: 10 },
            () => () =>
              new Promise((resolve) => setTimeout(() => resolve('heavy'), 150)),
          ),
          { concurrency: 3 },
        ),
      );

      // 2. Call stats API during heavy batch processing
      const statsRequests = Array.from({ length: 30 }, async () => {
        const startTime = Date.now();
        const response = await controller.getStats();
        const responseTime = Date.now() - startTime;

        expect(response).toBeDefined();
        expect(response.success).toBe(true);
        expect(response.data).toHaveProperty('webhooks');
        expect(response.data).toHaveProperty('cache');
        expect(response.data).toHaveProperty('batchProcessing');

        return responseTime;
      });

      const responseTimes = await Promise.all(statsRequests);

      // 3. Wait for all batch jobs to complete
      await Promise.all(heavyBatchPromises);

      const maxResponseTime = Math.max(...responseTimes);
      const avgResponseTime =
        responseTimes.reduce((sum, time) => sum + time, 0) /
        responseTimes.length;

      expect(maxResponseTime).toBeLessThan(20); // Max within 20ms
      expect(avgResponseTime).toBeLessThan(15); // Average within 15ms

      console.log(
        `Stats API during heavy load: avg ${avgResponseTime.toFixed(2)}ms, max ${maxResponseTime}ms`,
      );
    });
  });

  describe('Concurrent Load Testing', () => {
    it('should handle mixed API requests during batch processing without blocking', async () => {
      // 1. Start continuous batch jobs
      const continuousBatch = Array.from(
        { length: 50 },
        (_, i) => () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve(`continuous-${i}`),
              Math.random() * 100 + 50,
            ),
          ),
      );

      const batchPromise = batchService.executeBatch(continuousBatch, {
        concurrency: 10,
      });

      // 2. Call various API endpoints concurrently
      const mixedRequests = [
        // Health checks (fastest)
        ...Array.from({ length: 20 }, () => () => controller.getHealth()),

        // Recent notices (cached)
        ...Array.from(
          { length: 15 },
          () => () => controller.getRecentNotices(),
        ),

        // Batch status (status query)
        ...Array.from({ length: 10 }, () => () => controller.getBatchStatus()),

        // Stats (composite data)
        ...Array.from({ length: 5 }, () => () => controller.getStats()),
      ];

      // Execute all requests in random order
      const shuffled = mixedRequests.sort(() => Math.random() - 0.5);

      const startTime = Date.now();
      const responses = await Promise.all(
        shuffled.map(async (requestFn) => {
          const reqStartTime = Date.now();
          const response = await requestFn();
          return {
            responseTime: Date.now() - reqStartTime,
            success: response.success,
          };
        }),
      );
      const totalTime = Date.now() - startTime;

      // 3. Wait for batch jobs to complete
      await batchPromise;

      // 4. Verify results
      expect(responses).toHaveLength(50);
      expect(responses.every((r) => r.success)).toBe(true);

      const avgResponseTime =
        responses.reduce((sum, r) => sum + r.responseTime, 0) /
        responses.length;

      expect(totalTime).toBeLessThan(1000); // Complete within 1 second total
      expect(avgResponseTime).toBeLessThan(15); // Average within 15ms

      console.log(
        `Mixed load test: 50 requests in ${totalTime}ms (avg ${avgResponseTime.toFixed(2)}ms per request)`,
      );
    });
  });

  describe('Memory and Resource Efficiency', () => {
    it('should maintain stable memory usage during concurrent operations', async () => {
      const initialMemory = process.memoryUsage();

      // 1. Execute heavy batch jobs and API calls concurrently
      const batchPromises = Array.from({ length: 3 }, () =>
        batchService.executeBatch(
          Array.from(
            { length: 30 },
            () => () => Promise.resolve('memory-test'),
          ),
          { concurrency: 10 },
        ),
      );

      const apiCalls = Array.from({ length: 200 }, async () => {
        await controller.getHealth();
        await controller.getBatchStatus();
      });

      await Promise.all([...batchPromises, ...apiCalls]);

      const finalMemory = process.memoryUsage();
      const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;

      // Verify memory increase stays within reasonable bounds (under 10MB)
      expect(memoryIncrease).toBeLessThan(10 * 1024 * 1024);

      console.log(
        `Memory usage: ${(memoryIncrease / 1024 / 1024).toFixed(2)}MB increase`,
      );
    });
  });
});
