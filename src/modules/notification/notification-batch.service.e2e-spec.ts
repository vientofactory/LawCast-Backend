import { Test, TestingModule } from '@nestjs/testing';
import { NotificationBatchService } from './notification-batch.service';
import { WebhookService } from '../webhook/webhook.service';
import { NotificationService } from './notification.service';
import { NoticeArchiveService } from '../notice/notice-archive.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NoticeArchive } from '../notice/notice-archive.entity';
import { BatchProcessingService } from '../shared/batch-processing.service';
import { WebPushSubscriptionService } from './web-push-subscription.service';
import { WebPushNotificationService } from './web-push-notification.service';

const notices: any[] = [];
const notifications: any[] = [];

const mockNoticeArchiveRepo = {
  find: jest.fn(() => Promise.resolve(notices)),
  save: jest.fn((notice) => {
    notices.push(notice);
    return Promise.resolve(notice);
  }),
};

const mockNotificationService = {
  createNotification: jest.fn((notice) => {
    const notification = { id: notifications.length + 1, noticeId: notice.id };
    notifications.push(notification);
    return Promise.resolve(notification);
  }),
  sendDiscordNotificationBatch: jest.fn((notice, webhooks) =>
    Promise.resolve(
      webhooks.map((w: any) => ({ webhookId: w.id, success: true })),
    ),
  ),
};

const mockWebhookService = {
  findAll: jest.fn(() => [{ id: 1 }]),
  sendNotification: jest.fn(() => Promise.resolve(true)),
};

describe('NotificationBatchService E2E', () => {
  let batchService: NotificationBatchService;

  beforeEach(async () => {
    notices.length = 0;
    notifications.length = 0;
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationBatchService,
        {
          provide: getRepositoryToken(NoticeArchive),
          useValue: mockNoticeArchiveRepo,
        },
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: WebhookService, useValue: mockWebhookService },
        { provide: NoticeArchiveService, useValue: {} },
        {
          provide: WebPushSubscriptionService,
          useValue: { findAllActive: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: WebPushNotificationService,
          useValue: { sendNotification: jest.fn().mockResolvedValue({}) },
        },
        {
          provide: BatchProcessingService,
          useValue: {
            executeBatch: jest.fn(async (jobs: Function[]) => {
              const results: any[] = [];
              for (const job of jobs) {
                try {
                  const data = await job(new AbortController().signal);
                  results.push({ success: true, data });
                } catch (error) {
                  results.push({ success: false, data: {} });
                }
              }
              return results;
            }),
            updateRecentJobMetadata: jest.fn(),
          },
        },
      ],
    }).compile();

    batchService = module.get<NotificationBatchService>(
      NotificationBatchService,
    );
  });

  it('should detect new notice and send notification via webhook', async () => {
    // 1. 새로운 법률안 추가
    const newNotice = {
      num: 1,
      subject: '신규 법률안',
      proposerCategory: '정부',
      committee: '법제사법위원회',
      link: 'https://example.com/notice/1',
      contentId: 'abc123',
      attachments: { pdfFile: null, hwpFile: null },
    };
    await mockNoticeArchiveRepo.save(newNotice);

    // 2. 배치 실행 (fire-and-forget이므로 내부 Promise가 완료될 때까지 대기)
    await batchService.processNotificationBatch([newNotice]);
    // processNotificationBatch는 batchRunId를 즉시 반환하고 실제 dispatch는
    // .then() 체인에서 비동기로 실행되므로 microtask flush 필요
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // 3. 알림 전송 검증
    expect(
      mockNotificationService.sendDiscordNotificationBatch,
    ).toHaveBeenCalledWith(newNotice, [{ id: 1 }], expect.anything());
  });
});
