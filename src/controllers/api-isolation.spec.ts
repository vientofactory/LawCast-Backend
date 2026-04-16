/**
 * HTTP 처리와 배치 처리 간 격리 검증 테스트
 *
 * 이 테스트는 실제 API 컨트롤러가 배치 처리 중에도 정상적으로 HTTP 요청을 처리하는지 검증합니다.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ApiController } from '../controllers/api.controller';
import { BatchProcessingService } from '../services/batch-processing.service';
import { CrawlingService } from '../services/crawling.service';
import { WebhookService } from '../services/webhook.service';
import { NotificationService } from '../services/notification.service';
import { HashguardService } from '../services/hashguard.service';
import { WebhookCleanupService } from '../services/webhook-cleanup.service';
import { NoticeArchiveService } from '../services/notice-archive.service';
import { NoticesQueryService } from '../services/notices-query.service';

describe('HTTP-Batch Processing Isolation', () => {
  let controller: ApiController;
  let batchService: BatchProcessingService;
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

    const mockNotificationService = {
      sendDiscordNotificationBatch: jest.fn().mockResolvedValue([]),
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
      isRedisConnected: jest.fn().mockReturnValue(true),
    };

    const mockHashguardService = {
      verifyProof: jest.fn().mockResolvedValue(true),
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

    module = await Test.createTestingModule({
      controllers: [ApiController],
      providers: [
        BatchProcessingService,
        { provide: WebhookService, useValue: mockWebhookService },
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: CrawlingService, useValue: mockCrawlingService },
        { provide: HashguardService, useValue: mockHashguardService },
        { provide: WebhookCleanupService, useValue: mockWebhookCleanupService },
        { provide: NoticeArchiveService, useValue: mockNoticeArchiveService },
        { provide: NoticesQueryService, useValue: mockNoticesQueryService },
      ],
    }).compile();

    controller = module.get<ApiController>(ApiController);
    batchService = module.get<BatchProcessingService>(BatchProcessingService);
  });

  afterEach(async () => {
    await batchService.waitForAllBatchJobs();
    batchService.clearAllTimeouts();
    if (module) {
      await module.close();
    }
  });

  describe('API Responsiveness During Batch Processing', () => {
    it('should handle health checks instantly even during batch processing', async () => {
      // 1. 장시간 실행되는 배치 작업 시작
      const longRunningJobs = Array.from(
        { length: 10 },
        (_, i) => () =>
          new Promise((resolve) => setTimeout(() => resolve(`job-${i}`), 100)),
      );

      // 배치 처리 시작 (백그라운드에서 실행)
      const batchPromise = batchService.executeBatch(longRunningJobs, {
        concurrency: 3,
      });

      // 2. 배치 처리 중에 HTTP 요청 처리
      const healthRequests = Array.from({ length: 20 }, async () => {
        const startTime = Date.now();
        const response = await controller.getHealth();
        const responseTime = Date.now() - startTime;

        expect(response).toBeDefined();
        expect(response.success).toBe(true);
        expect(responseTime).toBeLessThan(10); // 10ms 이내 응답

        return responseTime;
      });

      const responseTimes = await Promise.all(healthRequests);
      const avgResponseTime =
        responseTimes.reduce((sum, time) => sum + time, 0) /
        responseTimes.length;

      // 3. 배치 작업 완료 대기
      const batchResults = await batchPromise;

      expect(batchResults.every((r) => r.success)).toBe(true);
      expect(avgResponseTime).toBeLessThan(5); // 평균 5ms 이내 응답

      console.log(
        `✅ Health API: avg response time ${avgResponseTime.toFixed(2)}ms during batch processing`,
      );
    });

    it('should serve recent notices quickly regardless of batch operations', async () => {
      // 1. 알림 배치 처리 시작 (논블로킹)
      const mockNotices = Array.from({ length: 5 }, (_, i) => ({
        subject: `Notice ${i}`,
        proposerCategory: 'Test',
        committee: 'Test',
        numComments: 0,
        link: `http://test.com/${i}`,
      }));

      await batchService.processNotificationBatch(mockNotices as any);

      // 2. 동시에 여러 클라이언트에서 최근 알림 조회
      const noticeRequests = Array.from({ length: 50 }, async () => {
        const startTime = Date.now();
        const response = await controller.getRecentNotices();
        const responseTime = Date.now() - startTime;

        expect(response).toBeDefined();
        expect(response.success).toBe(true);
        expect(Array.isArray(response.data)).toBe(true);
        expect(responseTime).toBeLessThanOrEqual(15); // 15ms 이내 응답 (여유 허용)

        return responseTime;
      });

      const responseTimes = await Promise.all(noticeRequests);
      const maxResponseTime = Math.max(...responseTimes);

      expect(maxResponseTime).toBeLessThanOrEqual(15); // 최대 15ms 이내 (여유 허용)

      console.log(
        `✅ Recent notices API: max response time ${maxResponseTime}ms (50 concurrent requests)`,
      );
    });

    it('should provide batch status without performance degradation', async () => {
      // 1. 다양한 크기의 배치 작업들 시작
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

      // 2. 배치 작업들이 실행되는 동안 상태 조회
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

      // 3. 모든 배치 작업 완료 대기
      await Promise.all([smallBatch, mediumBatch, largeBatch]);

      const avgResponseTime =
        results.reduce((sum, r) => sum + r.responseTime, 0) / results.length;

      expect(avgResponseTime).toBeLessThan(20); // 평균 20ms 이내 (환경 편차 허용)

      console.log(
        `✅ Batch status API: avg response time ${avgResponseTime.toFixed(2)}ms`,
      );
    });

    it('should handle stats API efficiently during heavy batch load', async () => {
      // 1. 많은 수의 배치 작업 시작
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

      // 2. 무거운 배치 작업 중에 stats API 호출
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

      // 3. 모든 배치 작업 완료 대기
      await Promise.all(heavyBatchPromises);

      const maxResponseTime = Math.max(...responseTimes);
      const avgResponseTime =
        responseTimes.reduce((sum, time) => sum + time, 0) /
        responseTimes.length;

      expect(maxResponseTime).toBeLessThan(20); // 최대 20ms 이내
      expect(avgResponseTime).toBeLessThan(10); // 평균 10ms 이내

      console.log(
        `✅ Stats API during heavy load: avg ${avgResponseTime.toFixed(2)}ms, max ${maxResponseTime}ms`,
      );
    });
  });

  describe('Concurrent Load Testing', () => {
    it('should handle mixed API requests during batch processing without blocking', async () => {
      // 1. 지속적인 배치 작업 시작
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

      // 2. 다양한 API 엔드포인트를 동시에 호출
      const mixedRequests = [
        // Health checks (가장 빨라야 함)
        ...Array.from({ length: 20 }, () => () => controller.getHealth()),

        // Recent notices (캐시에서 조회)
        ...Array.from(
          { length: 15 },
          () => () => controller.getRecentNotices(),
        ),

        // Batch status (상태 조회)
        ...Array.from({ length: 10 }, () => () => controller.getBatchStatus()),

        // Stats (복합 데이터)
        ...Array.from({ length: 5 }, () => () => controller.getStats()),
      ];

      // 모든 요청을 무작위 순서로 실행
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

      // 3. 배치 작업도 완료 대기
      await batchPromise;

      // 4. 결과 검증
      expect(responses).toHaveLength(50);
      expect(responses.every((r) => r.success)).toBe(true);

      const avgResponseTime =
        responses.reduce((sum, r) => sum + r.responseTime, 0) /
        responses.length;

      expect(totalTime).toBeLessThan(1000); // 전체 1초 이내
      expect(avgResponseTime).toBeLessThan(15); // 평균 15ms 이내

      console.log(
        `✅ Mixed load test: 50 requests in ${totalTime}ms (avg ${avgResponseTime.toFixed(2)}ms per request)`,
      );
    });
  });

  describe('Memory and Resource Efficiency', () => {
    it('should maintain stable memory usage during concurrent operations', async () => {
      const initialMemory = process.memoryUsage();

      // 1. 대량의 배치 작업과 API 호출을 동시에 실행
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

      // 메모리 증가가 합리적인 범위 내인지 확인 (10MB 이하)
      expect(memoryIncrease).toBeLessThan(10 * 1024 * 1024);

      console.log(
        `✅ Memory usage: ${(memoryIncrease / 1024 / 1024).toFixed(2)}MB increase`,
      );
    });
  });
});
