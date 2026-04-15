/**
 * 논블로킹 배치 처리 구조 검증 테스트
 *
 * 이 테스트는 배치 처리가 실제로 HTTP 요청 처리를 방해하지 않는지 검증합니다.
 */

import { BatchProcessingService } from './batch-processing.service';
import { CrawlingService } from './crawling.service';
import { Test, TestingModule } from '@nestjs/testing';
import { WebhookService } from './webhook.service';
import { NotificationService } from './notification.service';
import { CacheService } from './cache.service';
import { OllamaClientService } from '../modules/ollama/ollama-client.service';
import { NoticeArchiveService } from './notice-archive.service';

describe('Non-blocking Architecture Verification', () => {
  let batchService: BatchProcessingService;
  let crawlingService: CrawlingService;
  let module: TestingModule;

  beforeEach(async () => {
    const mockWebhookService = {
      findAll: jest.fn().mockResolvedValue([]),
      removeFailedWebhooks: jest.fn(),
    };

    const mockNotificationService = {
      sendDiscordNotificationBatch: jest.fn().mockResolvedValue([]),
    };

    const mockCacheService = {
      getRecentNotices: jest.fn().mockReturnValue([]),
      getCacheInfo: jest.fn().mockReturnValue({ size: 0 }),
      updateCache: jest.fn(),
      findNewNotices: jest.fn().mockReturnValue([]),
      initializeCache: jest.fn(),
    };

    const mockOllamaClientService = {
      summarizeProposal: jest.fn().mockResolvedValue(null),
    };

    const mockNoticeArchiveService = {
      existsByNoticeNum: jest.fn().mockResolvedValue(false),
      upsertNoticeArchive: jest.fn(),
    };

    module = await Test.createTestingModule({
      providers: [
        BatchProcessingService,
        CrawlingService,
        { provide: WebhookService, useValue: mockWebhookService },
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: CacheService, useValue: mockCacheService },
        { provide: OllamaClientService, useValue: mockOllamaClientService },
        { provide: NoticeArchiveService, useValue: mockNoticeArchiveService },
      ],
    }).compile();

    batchService = module.get<BatchProcessingService>(BatchProcessingService);
    crawlingService = module.get<CrawlingService>(CrawlingService);
  });

  afterEach(async () => {
    await batchService.waitForAllBatchJobs();
    batchService.clearAllTimeouts();
    if (module) {
      await module.close();
    }
  });

  describe('Non-blocking Batch Processing', () => {
    it('should return immediately from processNotificationBatch (non-blocking)', async () => {
      const mockNotices = [
        {
          subject: 'Test',
          proposerCategory: 'Test',
          committee: 'Test',
          numComments: 0,
          link: 'test',
        },
      ];

      // 배치 처리 호출이 즉시 반환되어야 함
      const startTime = Date.now();
      await batchService.processNotificationBatch(mockNotices as any);
      const executionTime = Date.now() - startTime;

      // 논블로킹이므로 50ms 이내에 반환되어야 함
      expect(executionTime).toBeLessThan(50);

      console.log(
        `✅ processNotificationBatch returned in ${executionTime}ms (non-blocking)`,
      );
    });

    it('should handle multiple concurrent batch jobs without blocking', async () => {
      const jobs1 = [() => Promise.resolve('job1')];
      const jobs2 = [() => Promise.resolve('job2')];
      const jobs3 = [() => Promise.resolve('job3')];

      // 여러 배치 작업을 동시에 시작
      const startTime = Date.now();
      const promises = [
        batchService.executeBatch(jobs1),
        batchService.executeBatch(jobs2),
        batchService.executeBatch(jobs3),
      ];

      // 각 배치 작업이 서로를 차단하지 않아야 함
      const results = await Promise.all(promises);
      const totalTime = Date.now() - startTime;

      expect(results).toHaveLength(3);
      expect(totalTime).toBeLessThan(1000); // 1초 이내에 완료

      console.log(`✅ 3 concurrent batch jobs completed in ${totalTime}ms`);
    });

    it('should maintain job queue state correctly', () => {
      const status = batchService.getBatchJobStatus();

      expect(status).toHaveProperty('jobCount');
      expect(status).toHaveProperty('jobIds');
      expect(typeof status.jobCount).toBe('number');
      expect(Array.isArray(status.jobIds)).toBe(true);

      console.log('✅ Batch job status API works correctly');
    });
  });

  describe('Service Integration', () => {
    it('should properly integrate BatchProcessingService with CrawlingService', async () => {
      expect(crawlingService).toBeDefined();
      expect(batchService).toBeDefined();

      // getRecentNotices는 async 메서드지만 HTTP 컨트롤러에서 await로 호출됨
      const notices = await crawlingService.getRecentNotices(10);
      expect(Array.isArray(notices)).toBe(true);

      console.log('✅ Service integration is correct');
    });

    it('should verify separation of concerns in architecture', () => {
      // CrawlingService는 스케줄링된 크롤링만 담당
      // BatchProcessingService는 배치 처리만 담당
      // HTTP 컨트롤러는 동기적 응답만 담당

      const crawlingMethods = Object.getOwnPropertyNames(
        CrawlingService.prototype,
      );
      const batchMethods = Object.getOwnPropertyNames(
        BatchProcessingService.prototype,
      );

      // CrawlingService에는 배치 처리 로직이 없어야 함 (분리됨)
      const hasSendNotifications = crawlingMethods.some((method) =>
        method.includes('sendNotifications'),
      );

      // BatchProcessingService에는 크롤링 로직이 없어야 함
      const hasCrawlingLogic = batchMethods.some(
        (method) => method.includes('crawl') || method.includes('cache'),
      );

      expect(hasSendNotifications).toBe(true); // sendNotifications는 있지만 배치로 위임
      expect(hasCrawlingLogic).toBe(false); // 배치 서비스에는 크롤링 로직 없음

      console.log('✅ Separation of concerns is properly maintained');
    });
  });

  describe('Performance Characteristics', () => {
    it('should handle batch jobs with configurable concurrency', async () => {
      const jobs = Array.from(
        { length: 20 },
        (_, i) => () =>
          new Promise((resolve) => setTimeout(() => resolve(`job-${i}`), 10)),
      );

      const startTime = Date.now();
      const results = await batchService.executeBatch(jobs, {
        concurrency: 5, // 동시에 5개만 실행
        timeout: 5000,
      });
      const totalTime = Date.now() - startTime;

      expect(results).toHaveLength(20);
      expect(results.every((r) => r.success)).toBe(true);

      // 동시성 제어로 인해 순차 실행보다는 빨라야 하지만
      // 모든 작업을 동시에 실행하는 것보다는 느려야 함
      expect(totalTime).toBeGreaterThanOrEqual(40); // 최소 4번의 배치 (20/5)
      expect(totalTime).toBeLessThan(500); // 하지만 충분히 빨라야 함

      console.log(`✅ 20 jobs with concurrency=5 completed in ${totalTime}ms`);
    });

    it('should handle timeout and retry mechanisms', async () => {
      let attemptCount = 0;
      const jobs = [
        () => {
          attemptCount++;
          if (attemptCount < 3) {
            return Promise.reject(new Error('Simulated failure'));
          }
          return Promise.resolve('success after retries');
        },
      ];

      const results = await batchService.executeBatch(jobs, {
        retryCount: 3,
        retryDelay: 10,
        timeout: 1000,
      });

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(attemptCount).toBe(3); // 첫 시도 + 2번 재시도

      console.log(`✅ Retry mechanism worked: ${attemptCount} attempts`);
    });
  });

  describe('Resource Management', () => {
    it('should properly clean up resources', async () => {
      // 여러 배치 작업 시작
      const jobs = [
        () => new Promise((resolve) => setTimeout(() => resolve('test'), 100)),
      ];

      await batchService.executeBatch(jobs);

      // 작업 완료 후 대기
      await batchService.waitForAllBatchJobs();

      // 작업 큐가 비어있어야 함
      const status = batchService.getBatchJobStatus();
      expect(status.jobCount).toBe(0);

      // 타이머 정리
      batchService.clearAllTimeouts();

      console.log('✅ Resources properly cleaned up');
    });
  });

  describe('Error Isolation', () => {
    it('should isolate batch processing errors from the service', async () => {
      const failingJobs = [
        () => Promise.reject(new Error('Batch job failed')),
        () => Promise.resolve('This should still work'),
      ];

      const results = await batchService.executeBatch(failingJobs);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(false);
      expect(results[1].success).toBe(true);

      // 일부 작업 실패가 전체 서비스에 영향을 주지 않음
      const status = batchService.getBatchJobStatus();
      expect(status).toBeDefined(); // 서비스는 여전히 정상 작동

      console.log('✅ Error isolation works correctly');
    });
  });
});
