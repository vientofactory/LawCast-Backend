import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';
import { NotificationBatchService } from './notification-batch.service';
import { type ChangeNotificationPayload } from './notification.service';
import { NoticeChangeSource } from '../change-tracking/notice-change-source.enum';
import { CHANGE_EVENT_TYPE } from '../change-tracking/notice-change-event.entity';
import { type WebPushSubscription } from './web-push-subscription.entity';

describe('NotificationBatchService (diffchain change batching)', () => {
  let webhookService: {
    findAll: jest.Mock;
    remove: jest.Mock;
  };
  let notificationService: {
    sendDiscordNotificationBatch: jest.Mock;
    sendDiscordNotificationDigestBatch: jest.Mock;
    sendDiscordChangeNotificationBatch: jest.Mock;
    sendDiscordChangeDigestNotificationBatch: jest.Mock;
    sendDiscordNoticePeriodEndedBatch: jest.Mock;
    sendDiscordNoticePeriodEndedDigestBatch: jest.Mock;
    clearPermanentFailureFlag: jest.Mock;
  };
  let batchProcessingService: {
    executeBatch: jest.Mock;
    updateRecentJobMetadata: jest.Mock;
  };
  let webPushSubscriptionService: {
    findAllActive: jest.Mock;
  };
  let webPushNotificationService: {
    sendNewNoticeBatch: jest.Mock;
    sendNewNoticeDigestBatch: jest.Mock;
    sendChangeBatch: jest.Mock;
    sendChangeDigestBatch: jest.Mock;
  };
  let service: NotificationBatchService;

  beforeEach(() => {
    webhookService = {
      findAll: jest
        .fn<
          () => Promise<Array<{ id: number; url: string; isActive: boolean }>>
        >()
        .mockResolvedValue([
          {
            id: 1,
            url: 'https://discord.com/api/webhooks/1/token1',
            isActive: true,
          },
        ]),
      remove: jest
        .fn<(...args: any[]) => Promise<void>>()
        .mockResolvedValue(undefined),
    };

    notificationService = {
      sendDiscordNotificationBatch: jest
        .fn<
          (
            ...args: any[]
          ) => Promise<Array<{ webhookId: number; success: boolean }>>
        >()
        .mockResolvedValue([{ webhookId: 1, success: true }]),
      sendDiscordNotificationDigestBatch: jest
        .fn<
          (
            ...args: any[]
          ) => Promise<Array<{ webhookId: number; success: boolean }>>
        >()
        .mockResolvedValue([{ webhookId: 1, success: true }]),
      sendDiscordChangeNotificationBatch: jest
        .fn<
          (
            ...args: any[]
          ) => Promise<Array<{ webhookId: number; success: boolean }>>
        >()
        .mockResolvedValue([{ webhookId: 1, success: true }]),
      sendDiscordChangeDigestNotificationBatch: jest
        .fn<
          (
            ...args: any[]
          ) => Promise<Array<{ webhookId: number; success: boolean }>>
        >()
        .mockResolvedValue([{ webhookId: 1, success: true }]),
      sendDiscordNoticePeriodEndedBatch: jest
        .fn<
          (
            ...args: any[]
          ) => Promise<Array<{ webhookId: number; success: boolean }>>
        >()
        .mockResolvedValue([{ webhookId: 1, success: true }]),
      sendDiscordNoticePeriodEndedDigestBatch: jest
        .fn<
          (
            ...args: any[]
          ) => Promise<Array<{ webhookId: number; success: boolean }>>
        >()
        .mockResolvedValue([{ webhookId: 1, success: true }]),
      clearPermanentFailureFlag: jest.fn<(...args: any[]) => void>(),
    };

    batchProcessingService = {
      executeBatch: jest.fn(async (...args: any[]) => {
        const jobs = args[0] as Array<
          (signal: AbortSignal) => Promise<unknown>
        >;
        const signal = new AbortController().signal;
        const results = await Promise.all(jobs.map((job) => job(signal)));
        return results.map((data, index) => ({
          success: true,
          jobId: `job-${index + 1}`,
          data,
        }));
      }),
      updateRecentJobMetadata: jest.fn(),
    };

    webPushSubscriptionService = {
      findAllActive: jest
        .fn<() => Promise<WebPushSubscription[]>>()
        .mockResolvedValue([
          {
            id: 11,
            endpoint: 'https://push.example/subscriptions/11',
            p256dh: 'p256dh-key',
            auth: 'auth-key',
            isActive: true,
          } as WebPushSubscription,
        ]),
    };

    webPushNotificationService = {
      sendNewNoticeBatch: jest
        .fn<
          (...args: any[]) => Promise<{
            targetCount: number;
            successCount: number;
            failedCount: number;
            deactivatedCount: number;
          }>
        >()
        .mockResolvedValue({
          targetCount: 1,
          successCount: 1,
          failedCount: 0,
          deactivatedCount: 0,
        }),
      sendNewNoticeDigestBatch: jest
        .fn<
          (...args: any[]) => Promise<{
            targetCount: number;
            successCount: number;
            failedCount: number;
            deactivatedCount: number;
          }>
        >()
        .mockResolvedValue({
          targetCount: 1,
          successCount: 1,
          failedCount: 0,
          deactivatedCount: 0,
        }),
      sendChangeBatch: jest
        .fn<
          (...args: any[]) => Promise<{
            targetCount: number;
            successCount: number;
            failedCount: number;
            deactivatedCount: number;
          }>
        >()
        .mockResolvedValue({
          targetCount: 1,
          successCount: 1,
          failedCount: 0,
          deactivatedCount: 0,
        }),
      sendChangeDigestBatch: jest
        .fn<
          (...args: any[]) => Promise<{
            targetCount: number;
            successCount: number;
            failedCount: number;
            deactivatedCount: number;
          }>
        >()
        .mockResolvedValue({
          targetCount: 1,
          successCount: 1,
          failedCount: 0,
          deactivatedCount: 0,
        }),
    };

    service = new NotificationBatchService(
      webhookService as any,
      notificationService as any,
      webPushSubscriptionService as any,
      webPushNotificationService as any,
      batchProcessingService as any,
      undefined as any,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('aggregates multiple notices into one digest notification job', async () => {
    const notices = [
      {
        num: 101,
        subject: '법률안 101',
        proposerCategory: '정부',
        committee: '법제사법위원회',
        link: 'https://example.com/notices/101',
        contentId: 'content-101',
        attachments: { pdfFile: '', hwpFile: '' },
      },
      {
        num: 102,
        subject: '법률안 102',
        proposerCategory: '의원',
        committee: '정무위원회',
        link: 'https://example.com/notices/102',
        contentId: 'content-102',
        attachments: { pdfFile: '', hwpFile: '' },
      },
    ];

    const results = await service.executeNotificationBatch(notices as any, {
      concurrency: 1,
    });

    expect(batchProcessingService.executeBatch).toHaveBeenCalledTimes(1);
    expect(
      notificationService.sendDiscordNotificationDigestBatch,
    ).toHaveBeenCalledTimes(1);
    expect(
      notificationService.sendDiscordNotificationBatch,
    ).not.toHaveBeenCalled();
    expect(
      webPushNotificationService.sendNewNoticeDigestBatch,
    ).toHaveBeenCalledTimes(1);
    expect(
      webPushNotificationService.sendNewNoticeBatch,
    ).not.toHaveBeenCalled();
    expect(
      notificationService.sendDiscordNotificationDigestBatch,
    ).toHaveBeenCalledWith(notices, expect.any(Array), expect.any(Object));
    expect(
      webPushNotificationService.sendNewNoticeDigestBatch,
    ).toHaveBeenCalledWith(notices, expect.any(Array));
    expect(results).toHaveLength(1);
    expect(results[0].data).toMatchObject({
      aggregatedNoticeCount: 2,
    });
  });

  it('keeps per-notice dispatch when notice count is one', async () => {
    const notices = [
      {
        num: 301,
        subject: '법률안 301',
        proposerCategory: '정부',
        committee: '법제사법위원회',
        link: 'https://example.com/notices/301',
        contentId: 'content-301',
        attachments: { pdfFile: '', hwpFile: '' },
      },
    ];

    const results = await service.executeNotificationBatch(notices as any, {
      concurrency: 1,
    });

    expect(
      notificationService.sendDiscordNotificationBatch,
    ).toHaveBeenCalledTimes(1);
    expect(
      notificationService.sendDiscordNotificationDigestBatch,
    ).not.toHaveBeenCalled();
    expect(webPushNotificationService.sendNewNoticeBatch).toHaveBeenCalledTimes(
      1,
    );
    expect(
      webPushNotificationService.sendNewNoticeDigestBatch,
    ).not.toHaveBeenCalled();
    expect(webPushNotificationService.sendNewNoticeBatch).toHaveBeenCalledWith(
      notices[0],
      expect.any(Array),
    );
    expect(results).toHaveLength(1);
    expect(results[0].data).toMatchObject({
      notice: '법률안 301',
    });
  });

  it('aggregates multiple payloads into one digest notification job', async () => {
    const payloads: ChangeNotificationPayload[] = [
      {
        noticeNum: 101,
        subject: '법률안 101',
        eventType: CHANGE_EVENT_TYPE.UPDATED,
        source: NoticeChangeSource.ARCHIVE_UPSERT,
        changedFields: ['subject'],
        eventHash: 'hash-101',
      },
      {
        noticeNum: 102,
        subject: '법률안 102',
        eventType: CHANGE_EVENT_TYPE.UPDATED,
        source: NoticeChangeSource.ARCHIVE_UPSERT,
        changedFields: ['committee'],
        eventHash: 'hash-102',
      },
    ];

    const results = await service.executeChangeNotificationBatch(payloads, {
      concurrency: 1,
    });

    expect(batchProcessingService.executeBatch).toHaveBeenCalledTimes(1);
    expect(
      notificationService.sendDiscordChangeDigestNotificationBatch,
    ).toHaveBeenCalledTimes(1);
    expect(
      notificationService.sendDiscordChangeNotificationBatch,
    ).not.toHaveBeenCalled();
    expect(
      webPushNotificationService.sendChangeDigestBatch,
    ).toHaveBeenCalledTimes(1);
    expect(webPushNotificationService.sendChangeBatch).not.toHaveBeenCalled();
    expect(
      notificationService.sendDiscordChangeDigestNotificationBatch,
    ).toHaveBeenCalledWith(payloads, expect.any(Array), expect.any(Object));
    expect(
      webPushNotificationService.sendChangeDigestBatch,
    ).toHaveBeenCalledWith(payloads, expect.any(Array), { ended: false });
    expect(results).toHaveLength(1);
    expect(results[0].data).toMatchObject({
      aggregatedEventCount: 2,
      aggregatedNoticeCount: 2,
    });
  });

  it('keeps per-event dispatch when payload count is one', async () => {
    const payloads: ChangeNotificationPayload[] = [
      {
        noticeNum: 301,
        subject: '법률안 301',
        eventType: CHANGE_EVENT_TYPE.UPDATED,
        source: NoticeChangeSource.ARCHIVE_UPSERT,
        changedFields: ['subject'],
        eventHash: 'hash-301',
      },
    ];

    const results = await service.executeChangeNotificationBatch(payloads, {
      concurrency: 1,
    });

    expect(
      notificationService.sendDiscordChangeNotificationBatch,
    ).toHaveBeenCalledTimes(1);
    expect(
      notificationService.sendDiscordChangeDigestNotificationBatch,
    ).not.toHaveBeenCalled();
    expect(webPushNotificationService.sendChangeBatch).toHaveBeenCalledTimes(1);
    expect(
      webPushNotificationService.sendChangeDigestBatch,
    ).not.toHaveBeenCalled();
    expect(webPushNotificationService.sendChangeBatch).toHaveBeenCalledWith(
      payloads[0],
      expect.any(Array),
    );
    expect(results).toHaveLength(1);
    expect(results[0].data).toMatchObject({
      noticeNum: 301,
      subject: '법률안 301',
    });
  });

  it('routes isDone payloads through the notice-period-ended notification path', async () => {
    const payloads: ChangeNotificationPayload[] = [
      {
        noticeNum: 401,
        subject: '종료 법률안 401',
        eventType: CHANGE_EVENT_TYPE.UPDATED,
        source: NoticeChangeSource.ARCHIVE_IS_DONE_SYNC,
        changedFields: ['isDone'],
        eventHash: 'hash-ended-401',
      },
      {
        noticeNum: 402,
        subject: '종료 법률안 402',
        eventType: CHANGE_EVENT_TYPE.UPDATED,
        source: NoticeChangeSource.ARCHIVE_IS_DONE_SYNC,
        changedFields: ['isDone'],
        eventHash: 'hash-ended-402',
      },
      {
        noticeNum: 403,
        subject: '일반 변경 법률안 403',
        eventType: CHANGE_EVENT_TYPE.UPDATED,
        source: NoticeChangeSource.ARCHIVE_UPSERT,
        changedFields: ['subject'],
        eventHash: 'hash-403',
      },
    ];

    const results = await service.executeChangeNotificationBatch(payloads, {
      concurrency: 1,
    });

    expect(
      notificationService.sendDiscordChangeDigestNotificationBatch,
    ).toHaveBeenCalledTimes(0);
    expect(
      notificationService.sendDiscordNoticePeriodEndedDigestBatch,
    ).toHaveBeenCalledTimes(1);
    expect(
      notificationService.sendDiscordChangeNotificationBatch,
    ).toHaveBeenCalledTimes(1);
    expect(
      notificationService.sendDiscordNoticePeriodEndedBatch,
    ).not.toHaveBeenCalled();
    expect(
      webPushNotificationService.sendChangeDigestBatch,
    ).toHaveBeenCalledTimes(1);
    expect(webPushNotificationService.sendChangeBatch).toHaveBeenCalledTimes(1);
    expect(
      webPushNotificationService.sendChangeDigestBatch,
    ).toHaveBeenCalledWith([payloads[0], payloads[1]], expect.any(Array), {
      ended: true,
    });
    expect(webPushNotificationService.sendChangeBatch).toHaveBeenCalledWith(
      payloads[2],
      expect.any(Array),
    );
    expect(results).toHaveLength(2);
  });

  it('does not send generic change notifications for isDone-only batches', async () => {
    const payloads: ChangeNotificationPayload[] = [
      {
        noticeNum: 501,
        subject: '종료 법률안 501',
        eventType: CHANGE_EVENT_TYPE.UPDATED,
        source: NoticeChangeSource.ARCHIVE_IS_DONE_SYNC,
        changedFields: ['isDone'],
        eventHash: 'hash-ended-501',
      },
      {
        noticeNum: 502,
        subject: '종료 법률안 502',
        eventType: CHANGE_EVENT_TYPE.UPDATED,
        source: NoticeChangeSource.ARCHIVE_IS_DONE_SYNC,
        changedFields: ['isDone'],
        eventHash: 'hash-ended-502',
      },
    ];

    const results = await service.executeChangeNotificationBatch(payloads, {
      concurrency: 1,
    });

    expect(
      notificationService.sendDiscordChangeNotificationBatch,
    ).not.toHaveBeenCalled();
    expect(
      notificationService.sendDiscordChangeDigestNotificationBatch,
    ).not.toHaveBeenCalled();
    expect(
      notificationService.sendDiscordNoticePeriodEndedDigestBatch,
    ).toHaveBeenCalledTimes(1);
    expect(
      notificationService.sendDiscordNoticePeriodEndedBatch,
    ).not.toHaveBeenCalled();
    expect(
      webPushNotificationService.sendChangeDigestBatch,
    ).toHaveBeenCalledTimes(1);
    expect(webPushNotificationService.sendChangeBatch).not.toHaveBeenCalled();
    expect(
      webPushNotificationService.sendChangeDigestBatch,
    ).toHaveBeenCalledWith(payloads, expect.any(Array), { ended: true });
    expect(results).toHaveLength(1);
    expect(results[0].data).toMatchObject({
      aggregatedEventCount: 2,
      aggregatedNoticeCount: 2,
    });
  });

  it('skips web push dispatch when there are no active subscriptions', async () => {
    (
      webPushSubscriptionService.findAllActive as jest.Mock
    ).mockImplementationOnce(async () => []);

    const notices = [
      {
        num: 901,
        subject: '법률안 901',
        proposerCategory: '정부',
        committee: '법제사법위원회',
        link: 'https://example.com/notices/901',
        contentId: 'content-901',
        attachments: { pdfFile: '', hwpFile: '' },
      },
    ];

    const results = await service.executeNotificationBatch(notices as any, {
      concurrency: 1,
    });

    expect(notificationService.sendDiscordNotificationBatch).toHaveBeenCalled();
    expect(
      webPushNotificationService.sendNewNoticeBatch,
    ).not.toHaveBeenCalled();
    expect(
      webPushNotificationService.sendNewNoticeDigestBatch,
    ).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
  });

  it('keeps batch successful while recording web push failures in job data', async () => {
    webPushNotificationService.sendChangeBatch.mockImplementationOnce(
      async () => ({
        targetCount: 1,
        successCount: 0,
        failedCount: 1,
        deactivatedCount: 0,
      }),
    );

    const payloads: ChangeNotificationPayload[] = [
      {
        noticeNum: 1001,
        subject: '법률안 1001',
        eventType: CHANGE_EVENT_TYPE.UPDATED,
        source: NoticeChangeSource.ARCHIVE_UPSERT,
        changedFields: ['subject'],
        eventHash: 'hash-1001',
      },
    ];

    const results = await service.executeChangeNotificationBatch(payloads, {
      concurrency: 1,
    });

    expect(
      notificationService.sendDiscordChangeNotificationBatch,
    ).toHaveBeenCalledTimes(1);
    expect(webPushNotificationService.sendChangeBatch).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].data).toMatchObject({
      webPushSuccessCount: 0,
      webPushFailedCount: 1,
      webPushDeactivatedCount: 0,
    });
  });

  it('processChangeNotificationBatch accepts payload arrays without splitting to separate batch runs', async () => {
    const payloads: ChangeNotificationPayload[] = [
      {
        noticeNum: 201,
        subject: '법률안 201',
        eventType: CHANGE_EVENT_TYPE.UPDATED,
        source: NoticeChangeSource.ARCHIVE_UPDATE_SOURCE_HTML,
        changedFields: ['proposer'],
        eventHash: 'hash-201',
      },
      {
        noticeNum: 202,
        subject: '법률안 202',
        eventType: CHANGE_EVENT_TYPE.UPDATED,
        source: NoticeChangeSource.ARCHIVE_UPDATE_NSM_HTML_AND_DETAIL,
        changedFields: ['proposalReason'],
        eventHash: 'hash-202',
      },
    ];

    const executeSpy = jest.spyOn(service, 'executeChangeNotificationBatch');

    const batchRunId = await service.processChangeNotificationBatch(payloads, {
      concurrency: 1,
    });

    expect(batchRunId).toContain('change_notification_batch');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith(
      payloads,
      expect.objectContaining({
        concurrency: 1,
        batchRunId: expect.any(String),
      }),
    );
  });
});
