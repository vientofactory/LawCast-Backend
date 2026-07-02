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

describe('NotificationBatchService (diffchain change batching)', () => {
  let webhookService: {
    findAll: jest.Mock;
    remove: jest.Mock;
  };
  let notificationService: {
    sendDiscordChangeNotificationBatch: jest.Mock;
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
      clearPermanentFailureFlag: jest.fn<(...args: any[]) => void>(),
    };

    batchProcessingService = {
      executeBatch: jest.fn(
        async (jobs: Array<(signal: AbortSignal) => Promise<any>>) => {
          const signal = new AbortController().signal;
          const results = await Promise.all(jobs.map((job) => job(signal)));
          return results.map((data, index) => ({
            success: true,
            jobId: `job-${index + 1}`,
            data,
          }));
        },
      ),
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

  it('executes one batch containing multiple change payload jobs', async () => {
    const payloads: ChangeNotificationPayload[] = [
      {
        noticeNum: 101,
        subject: '법률안 101',
        eventType: 'updated',
        source: 'archive:upsert',
        changedFields: ['subject'],
        eventHash: 'hash-101',
      },
      {
        noticeNum: 102,
        subject: '법률안 102',
        eventType: 'updated',
        source: 'archive:upsert',
        changedFields: ['committee'],
        eventHash: 'hash-102',
      },
    ];

    const results = await service.executeChangeNotificationBatch(payloads, {
      concurrency: 1,
    });

    expect(batchProcessingService.executeBatch).toHaveBeenCalledTimes(1);
    expect(
      notificationService.sendDiscordChangeNotificationBatch,
    ).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results[0].data).toMatchObject({
      noticeNum: 101,
      subject: '법률안 101',
    });
    expect(results[1].data).toMatchObject({
      noticeNum: 102,
      subject: '법률안 102',
    });
  });

  it('processChangeNotificationBatch accepts payload arrays without splitting to separate batch runs', async () => {
    const payloads: ChangeNotificationPayload[] = [
      {
        noticeNum: 201,
        subject: '법률안 201',
        eventType: 'updated',
        source: 'archive:updateSourceHtml',
        changedFields: ['sourceHtmlSha256'],
        eventHash: 'hash-201',
      },
      {
        noticeNum: 202,
        subject: '법률안 202',
        eventType: 'updated',
        source: 'archive:updateNsmHtmlAndDetail',
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
