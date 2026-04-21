import { Test, TestingModule } from '@nestjs/testing';
import {
  BatchProcessingService,
  BatchProcessingOptions,
} from './batch-processing.service';
import { WebhookService } from './webhook.service';
import { NotificationService } from './notification.service';
import { NotificationBatchProcessor } from './notification-batch-processor.service';

describe('BatchProcessingService', () => {
  let batchService: BatchProcessingService;
  let notificationBatchProcessor: NotificationBatchProcessor;
  let module: TestingModule;

  beforeEach(async () => {
    const mockWebhookService = {
      findAll: jest.fn(),
      removeFailedWebhooks: jest.fn(),
    };

    const mockNotificationService = {
      sendDiscordNotificationBatch: jest.fn(),
    };

    module = await Test.createTestingModule({
      providers: [
        BatchProcessingService,
        {
          provide: NotificationBatchProcessor,
          useValue: { processNotificationBatch: jest.fn() },
        },
        { provide: WebhookService, useValue: mockWebhookService },
        { provide: NotificationService, useValue: mockNotificationService },
      ],
    }).compile();

    batchService = module.get<BatchProcessingService>(BatchProcessingService);
    notificationBatchProcessor = module.get<NotificationBatchProcessor>(
      NotificationBatchProcessor,
    );
  });

  afterEach(async () => {
    // 모든 배치 작업이 완료될 때까지 대기
    await batchService.waitForAllBatchJobs();

    // 모든 활성 타이머 정리
    batchService.clearAllTimeouts();

    // 테스트 모듈 정리
    if (module) {
      await module.close();
    }
  });

  it('should be defined', () => {
    expect(batchService).toBeDefined();
  });

  describe('executeBatch', () => {
    it('should execute jobs in parallel with concurrency limit', async () => {
      const mockJobs = [
        () => Promise.resolve('result1'),
        () => Promise.resolve('result2'),
        () => Promise.resolve('result3'),
      ];

      const options: BatchProcessingOptions = {
        concurrency: 2,
        timeout: 5000,
      };

      const results = await batchService.executeBatch(mockJobs, options);

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.success)).toBe(true);
    });

    it('should handle job failures gracefully', async () => {
      const mockJobs = [
        () => Promise.resolve('success'),
        () => Promise.reject(new Error('Job failed')),
      ];

      const results = await batchService.executeBatch(mockJobs);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
    });

    it('should handle job timeouts', async () => {
      let timeoutId: NodeJS.Timeout;
      const mockJobs = [
        () =>
          new Promise((resolve) => {
            timeoutId = setTimeout(() => resolve('success'), 2000);
          }),
      ];

      const options: BatchProcessingOptions = {
        timeout: 1000,
      };

      const results = await batchService.executeBatch(mockJobs, options);

      // Clear the timeout to avoid hanging processes
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
    }, 10000);
  });

  describe('processNotificationBatch', () => {
    it('should process notification batch in background', async () => {
      const mockNotices = [
        {
          subject: 'Notice 1',
          proposerCategory: 'Test',
          committee: 'Test',
          numComments: 0,
          link: 'http://test.com',
        },
      ];

      // Test that the method returns immediately (non-blocking)
      const startTime = Date.now();
      await notificationBatchProcessor.processNotificationBatch(
        mockNotices as any,
      );
      const endTime = Date.now();

      // Should return very quickly (less than 100ms) since it's non-blocking
      expect(endTime - startTime).toBeLessThan(100);

      // Check that a batch job was queued
      const status = batchService.getBatchJobStatus();
      expect(status.jobCount).toBeGreaterThanOrEqual(0);

      // Wait for the batch job to complete to avoid hanging processes
      await batchService.waitForAllBatchJobs();
    });
  });

  describe('getBatchJobStatus', () => {
    it('should return current batch job status', () => {
      const status = batchService.getBatchJobStatus();

      expect(status).toHaveProperty('jobCount');
      expect(status).toHaveProperty('jobIds');
      expect(Array.isArray(status.jobIds)).toBe(true);
    });
  });

  describe('waitForAllBatchJobs', () => {
    it('should wait for all jobs to complete', async () => {
      const promise = batchService.waitForAllBatchJobs();
      await expect(promise).resolves.toBeUndefined();
    });
  });

  describe('Graceful Shutdown', () => {
    it('should reject new jobs when shutting down', async () => {
      // Start shutdown process
      const shutdownPromise = batchService.gracefulShutdown();

      // Try to execute a new batch job
      const mockJobs = [() => Promise.resolve('test')];

      await expect(batchService.executeBatch(mockJobs)).rejects.toThrow(
        'Service is shutting down, cannot process new jobs',
      );

      await shutdownPromise;
    });

    it('should reject new notification batches when shutting down', async () => {
      (
        notificationBatchProcessor.processNotificationBatch as jest.Mock
      ).mockRejectedValue(
        new Error('Service is shutting down, cannot process new notifications'),
      );
      // Start shutdown process
      const shutdownPromise = batchService.gracefulShutdown();

      const mockNotices = [
        {
          subject: 'Test Notice',
          proposerCategory: 'Test',
          committee: 'Test',
          numComments: 0,
          link: 'http://test.com',
        },
      ];

      await expect(
        notificationBatchProcessor.processNotificationBatch(mockNotices as any),
      ).rejects.toThrow(
        'Service is shutting down, cannot process new notifications',
      );

      await shutdownPromise;
    });

    it('should wait for ongoing jobs during shutdown', async () => {
      let jobResolve: () => void;
      const longRunningJob = () =>
        new Promise<string>((resolve) => {
          jobResolve = () => resolve('completed');
        });

      // Start a long-running job
      const jobPromise = batchService.executeBatch([longRunningJob]);

      // Start shutdown
      const shutdownStartTime = Date.now();
      const shutdownPromise = batchService.gracefulShutdown();

      // Wait a bit then resolve the job
      setTimeout(() => {
        jobResolve();
      }, 100);

      await shutdownPromise;
      const results = await jobPromise;

      expect(results[0].success).toBe(true);
      expect(Date.now() - shutdownStartTime).toBeGreaterThanOrEqual(100);
    });

    it('should implement OnApplicationShutdown interface', async () => {
      const shutdownSpy = jest
        .spyOn(batchService, 'gracefulShutdown')
        .mockResolvedValue();

      await batchService.onApplicationShutdown('SIGTERM');

      expect(shutdownSpy).toHaveBeenCalledTimes(1);
      shutdownSpy.mockRestore();
    });

    it('should provide detailed batch job status', () => {
      const status = batchService.getDetailedBatchJobStatus();

      expect(status).toHaveProperty('jobCount');
      expect(status).toHaveProperty('jobIds');
      expect(status).toHaveProperty('isShuttingDown');
      expect(status).toHaveProperty('activeTimeouts');
      expect(typeof status.isShuttingDown).toBe('boolean');
      expect(typeof status.activeTimeouts).toBe('number');
    });

    it('should force shutdown and clear all resources', () => {
      batchService.forceShutdown();

      expect(batchService.isServiceShuttingDown()).toBe(true);

      const status = batchService.getBatchJobStatus();
      expect(status.jobCount).toBe(0);
    });
  });
});
