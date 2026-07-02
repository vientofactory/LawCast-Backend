import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';
import { ChangeTrackingService } from './change-tracking.service';

describe('ChangeTrackingService (diffchain batching)', () => {
  const createService = () => {
    const notificationBatchService = {
      processChangeNotificationBatch: jest
        .fn<(...args: any[]) => Promise<string>>()
        .mockResolvedValue('job-change-1'),
    };

    const changeEventRepository = {} as any;
    const changeDetailRepository = {} as any;

    const service = new ChangeTrackingService(
      changeEventRepository,
      changeDetailRepository,
      notificationBatchService as any,
    );

    return { service, notificationBatchService };
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('queues during collection and flushes once at collection end', async () => {
    const { service, notificationBatchService } = createService();

    service.beginChangeNotificationCollection();

    await service.dispatchChangeNotification({
      event: {
        id: 1,
        noticeNum: 1001,
        eventType: 'updated',
        source: 'archive:upsert',
        eventHash: 'hash-1',
      } as any,
      subject: '법률안 A',
      changedFields: ['subject'],
    });

    await service.dispatchChangeNotification({
      event: {
        id: 2,
        noticeNum: 1002,
        eventType: 'updated',
        source: 'archive:upsert',
        eventHash: 'hash-2',
      } as any,
      subject: '법률안 B',
      changedFields: ['committee'],
    });

    await jest.advanceTimersByTimeAsync(200);
    expect(
      notificationBatchService.processChangeNotificationBatch,
    ).not.toHaveBeenCalled();

    await service.endChangeNotificationCollection();

    expect(
      notificationBatchService.processChangeNotificationBatch,
    ).toHaveBeenCalledTimes(1);
    const [payloads] = (
      notificationBatchService.processChangeNotificationBatch as jest.Mock
    ).mock.calls[0];

    expect(Array.isArray(payloads)).toBe(true);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ noticeNum: 1001, subject: '법률안 A' });
    expect(payloads[1]).toMatchObject({ noticeNum: 1002, subject: '법률안 B' });
  });

  it('does not flush on nested collection end until outer collection completes', async () => {
    const { service, notificationBatchService } = createService();

    service.beginChangeNotificationCollection();
    service.beginChangeNotificationCollection();

    await service.dispatchChangeNotification({
      event: {
        id: 3,
        noticeNum: 2001,
        eventType: 'updated',
        source: 'archive:updateSourceHtml',
        eventHash: 'hash-nested',
      } as any,
      subject: '중첩 테스트',
      changedFields: ['sourceHtmlSha256'],
    });

    await service.endChangeNotificationCollection();
    expect(
      notificationBatchService.processChangeNotificationBatch,
    ).not.toHaveBeenCalled();

    await service.endChangeNotificationCollection();
    expect(
      notificationBatchService.processChangeNotificationBatch,
    ).toHaveBeenCalledTimes(1);
  });

  it('auto-flushes by timer when not in collection mode', async () => {
    const { service, notificationBatchService } = createService();

    await service.dispatchChangeNotification({
      event: {
        id: 4,
        noticeNum: 3001,
        eventType: 'updated',
        source: 'archive:updateNsmHtmlAndDetail',
        eventHash: 'hash-auto',
      } as any,
      subject: '자동 flush 테스트',
      changedFields: ['proposalReason'],
    });

    expect(
      notificationBatchService.processChangeNotificationBatch,
    ).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(120);

    expect(
      notificationBatchService.processChangeNotificationBatch,
    ).toHaveBeenCalledTimes(1);
  });
});
