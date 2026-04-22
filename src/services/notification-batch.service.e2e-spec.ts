import { Test, TestingModule } from '@nestjs/testing';
import { NotificationBatchService } from './notification-batch.service';
import { WebhookService } from './webhook.service';
import { NotificationService } from './notification.service';
import { NoticeArchiveService } from './notice-archive.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NoticeArchive } from '../entities/notice-archive.entity';
import { BatchProcessingService } from './batch-processing.service';

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
          provide: BatchProcessingService,
          useValue: {
            executeBatch: jest.fn((jobs) =>
              Promise.all(jobs.map((job) => job(new AbortController().signal))),
            ),
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

    // 2. 배치 실행
    await batchService.processNotificationBatch([newNotice]);

    // 3. 알림 전송 검증
    expect(
      mockNotificationService.sendDiscordNotificationBatch,
    ).toHaveBeenCalledWith(newNotice, [{ id: 1 }], expect.anything());
    // expect(mockWebhookService.sendNotification).toHaveBeenCalled();
  });
});
