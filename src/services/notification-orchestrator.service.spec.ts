import { Test, TestingModule } from '@nestjs/testing';
import { NotificationOrchestratorService } from './notification-orchestrator.service';
import { NotificationBatchService } from './notification-batch.service';
import { type CachedNotice } from '../types/cache.types';

describe('NotificationOrchestratorService', () => {
  let service: NotificationOrchestratorService;
  let notificationBatchService: NotificationBatchService;

  const mockNotices: CachedNotice[] = [
    {
      num: 1,
      subject: '테스트 입법예고 1',
      proposerCategory: '정부',
      committee: '법제사법위원회',
      link: 'https://example.com/notice/1',
      contentId: 'content-1',
      attachments: { pdfFile: '', hwpFile: '' },
      aiSummary: 'AI 요약 1',
      aiSummaryStatus: 'ready',
    },
    {
      num: 2,
      subject: '테스트 입법예고 2',
      proposerCategory: '의원',
      committee: '국정감사위원회',
      link: 'https://example.com/notice/2',
      contentId: 'content-2',
      attachments: { pdfFile: '', hwpFile: '' },
      aiSummary: 'AI 요약 2',
      aiSummaryStatus: 'ready',
    },
  ];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationOrchestratorService,
        {
          provide: NotificationBatchService,
          useValue: {
            processNotificationBatch: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<NotificationOrchestratorService>(
      NotificationOrchestratorService,
    );
    notificationBatchService = module.get<NotificationBatchService>(
      NotificationBatchService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('sendNotifications', () => {
    it('should process small batch of notifications with default options', async () => {
      const mockJobId = 'job-123';
      (
        notificationBatchService.processNotificationBatch as jest.Mock
      ).mockResolvedValue(mockJobId);

      await service.sendNotifications(mockNotices);

      expect(
        notificationBatchService.processNotificationBatch,
      ).toHaveBeenCalledWith(mockNotices, {
        concurrency: 5,
        timeout: 30000,
        retryCount: 3,
        retryDelay: 1000,
      });
    });

    it('should apply batch size limit for large notification batches', async () => {
      const largeNotices = Array.from({ length: 60 }, (_, i) => ({
        ...mockNotices[0],
        num: i + 1,
        subject: `테스트 입법예고 ${i + 1}`,
        link: `https://example.com/notice/${i + 1}`,
        contentId: `content-${i + 1}`,
      }));

      const mockJobId = 'job-large-123';
      (
        notificationBatchService.processNotificationBatch as jest.Mock
      ).mockResolvedValue(mockJobId);

      await service.sendNotifications(largeNotices);

      expect(
        notificationBatchService.processNotificationBatch,
      ).toHaveBeenCalledWith(largeNotices, {
        concurrency: 5,
        timeout: 30000,
        retryCount: 3,
        retryDelay: 1000,
        batchSize: 50,
      });
    });

    it('should not apply batch size limit for exactly 50 notices', async () => {
      const exactly50Notices = Array.from({ length: 50 }, (_, i) => ({
        ...mockNotices[0],
        num: i + 1,
        subject: `테스트 입법예고 ${i + 1}`,
        link: `https://example.com/notice/${i + 1}`,
        contentId: `content-${i + 1}`,
      }));

      const mockJobId = 'job-50-123';
      (
        notificationBatchService.processNotificationBatch as jest.Mock
      ).mockResolvedValue(mockJobId);

      await service.sendNotifications(exactly50Notices);

      expect(
        notificationBatchService.processNotificationBatch,
      ).toHaveBeenCalledWith(exactly50Notices, {
        concurrency: 5,
        timeout: 30000,
        retryCount: 3,
        retryDelay: 1000,
      });
    });

    it('should handle empty notices array', async () => {
      const mockJobId = 'job-empty-123';
      (
        notificationBatchService.processNotificationBatch as jest.Mock
      ).mockResolvedValue(mockJobId);

      await service.sendNotifications([]);

      expect(
        notificationBatchService.processNotificationBatch,
      ).toHaveBeenCalledWith([], {
        concurrency: 5,
        timeout: 30000,
        retryCount: 3,
        retryDelay: 1000,
      });
    });

    it('should throw error when notification batch processing fails', async () => {
      const error = new Error('Batch processing failed');
      (
        notificationBatchService.processNotificationBatch as jest.Mock
      ).mockRejectedValue(error);

      await expect(service.sendNotifications(mockNotices)).rejects.toThrow(
        'Batch processing failed',
      );
      expect(
        notificationBatchService.processNotificationBatch,
      ).toHaveBeenCalledWith(mockNotices, {
        concurrency: 5,
        timeout: 30000,
        retryCount: 3,
        retryDelay: 1000,
      });
    });

    it('should log appropriate messages for different batch sizes', async () => {
      const mockJobId = 'job-log-123';
      (
        notificationBatchService.processNotificationBatch as jest.Mock
      ).mockResolvedValue(mockJobId);

      // Spy on logger
      const loggerSpy = jest.spyOn(service['logger'], 'log');

      // Test small batch
      await service.sendNotifications(mockNotices);
      expect(loggerSpy).toHaveBeenCalledWith(
        'Started notification batch processing for 2 notices (job: job-log-123)',
      );

      // Reset spy
      loggerSpy.mockClear();

      // Test large batch
      const largeNotices = Array.from({ length: 60 }, (_, i) => ({
        ...mockNotices[0],
        num: i + 1,
      }));

      await service.sendNotifications(largeNotices);
      expect(loggerSpy).toHaveBeenCalledWith(
        'Large notification batch detected (60 notices), applying batch size limit of 50',
      );
      expect(loggerSpy).toHaveBeenCalledWith(
        'Started notification batch processing for 60 notices (job: job-log-123)',
      );
    });
  });
});
