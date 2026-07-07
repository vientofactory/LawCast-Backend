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

describe('NotificationBatchService (diffchain change batching)', () => {
  let webhookService: {
    findAll: jest.Mock;
    remove: jest.Mock;
  };
  let notificationService: {
    sendDiscordChangeNotificationBatch: jest.Mock;
    sendDiscordChangeDigestNotificationBatch: jest.Mock;
    clearPermanentFailureFlag: jest.Mock;
  };
  let batchProcessingService: {
    executeBatch: jest.Mock;
    updateRecentJobMetadata: jest.Mock;
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

    service = new NotificationBatchService(
      webhookService as any,
      notificationService as any,
      batchProcessingService as any,
      undefined as any,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('aggregates multiple payloads into one digest notification job', async () => {
    const payloads: ChangeNotificationPayload[] = [
      {
        noticeNum: 101,
        subject: '법률안 101',
        eventType: 'updated',
        source: NoticeChangeSource.ARCHIVE_UPSERT,
        changedFields: ['subject'],
        eventHash: 'hash-101',
      },
      {
        noticeNum: 102,
        subject: '법률안 102',
        eventType: 'updated',
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
      notificationService.sendDiscordChangeDigestNotificationBatch,
    ).toHaveBeenCalledWith(payloads, expect.any(Array), expect.any(Object));
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
        eventType: 'updated',
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
    expect(results).toHaveLength(1);
    expect(results[0].data).toMatchObject({
      noticeNum: 301,
      subject: '법률안 301',
    });
  });

  it('processChangeNotificationBatch accepts payload arrays without splitting to separate batch runs', async () => {
    const payloads: ChangeNotificationPayload[] = [
      {
        noticeNum: 201,
        subject: '법률안 201',
        eventType: 'updated',
        source: NoticeChangeSource.ARCHIVE_UPDATE_SOURCE_HTML,
        changedFields: ['proposer'],
        eventHash: 'hash-201',
      },
      {
        noticeNum: 202,
        subject: '법률안 202',
        eventType: 'updated',
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
