import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';
import { ChangeTrackingService } from './change-tracking.service';
import { NoticeChangeEvent } from './notice-change-event.entity';
import { NoticeChangeDetail } from './notice-change-detail.entity';
import { NoticeChangeSource } from './notice-change-source.enum';

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
      undefined as any,
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
        source: NoticeChangeSource.ARCHIVE_UPSERT,
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
        source: NoticeChangeSource.ARCHIVE_UPSERT,
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
        source: NoticeChangeSource.ARCHIVE_UPDATE_SOURCE_HTML,
        eventHash: 'hash-nested',
      } as any,
      subject: '중첩 테스트',
      changedFields: ['proposer'],
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
        source: NoticeChangeSource.ARCHIVE_UPDATE_NSM_HTML_AND_DETAIL,
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

  it('skips created events because regular notice notifications already cover them', async () => {
    const { service, notificationBatchService } = createService();

    await service.dispatchChangeNotification({
      event: {
        id: 5,
        noticeNum: 4001,
        eventType: 'created',
        source: NoticeChangeSource.ARCHIVE_UPSERT,
        eventHash: 'hash-created',
      } as any,
      subject: '신규 법률안',
      changedFields: ['subject'],
    });

    await jest.advanceTimersByTimeAsync(200);

    expect(
      notificationBatchService.processChangeNotificationBatch,
    ).not.toHaveBeenCalled();
  });

  it('skips bootstrap source events to prevent notifications during genesis seeding', async () => {
    const { service, notificationBatchService } = createService();

    await service.dispatchChangeNotification({
      event: {
        id: 6,
        noticeNum: 5001,
        eventType: 'updated',
        source: NoticeChangeSource.BOOTSTRAP_LEGACY_SEED,
        eventHash: 'hash-bootstrap-suppressed',
      } as any,
      subject: '레거시 제네시스 시딩 대상',
      changedFields: ['subject'],
    });

    await jest.advanceTimersByTimeAsync(200);

    expect(
      notificationBatchService.processChangeNotificationBatch,
    ).not.toHaveBeenCalled();
  });

  it('suppresses all change notifications while bootstrap suppression is active', async () => {
    const { service, notificationBatchService } = createService();

    service.beginChangeNotificationSuppression();

    await service.dispatchChangeNotification({
      event: {
        id: 7,
        noticeNum: 5002,
        eventType: 'updated',
        source: NoticeChangeSource.ARCHIVE_UPSERT,
        eventHash: 'hash-bootstrap-blocked',
      } as any,
      subject: '부트스트랩 전체 차단 테스트',
      changedFields: ['committee'],
    });

    await jest.advanceTimersByTimeAsync(200);

    expect(
      notificationBatchService.processChangeNotificationBatch,
    ).not.toHaveBeenCalled();

    service.endChangeNotificationSuppression();
  });

  it('retries atomic append on event-height unique conflicts', async () => {
    const inTxEventRepo = {
      findOne: jest
        .fn<(...args: any[]) => Promise<any>>()
        .mockResolvedValue({ eventHeight: 3, eventHash: 'prev-hash' }),
      create: jest.fn((payload: unknown) => payload),
      save: jest
        .fn<(...args: any[]) => Promise<any>>()
        .mockRejectedValueOnce(
          new Error(
            'UNIQUE constraint failed: notice_change_events.notice_num, notice_change_events.event_height',
          ),
        )
        .mockResolvedValueOnce({
          id: 999,
          noticeNum: 1001,
          eventHeight: 4,
          eventHash: 'hash-atomic-1',
        }),
    };

    const inTxDetailRepo = {
      create: jest.fn((payload: unknown) => payload),
      save: jest
        .fn<(...args: any[]) => Promise<void>>()
        .mockResolvedValue(undefined),
    };

    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === NoticeChangeEvent) return inTxEventRepo;
        if (entity === NoticeChangeDetail) return inTxDetailRepo;
        throw new Error('Unexpected repository requested in test');
      }),
    };

    const changeEventRepository = {
      manager: {
        transaction: jest
          .fn<(fn: (manager: any) => Promise<any>) => Promise<any>>()
          .mockImplementation(async (fn) => fn(manager)),
      },
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    } as any;

    const service = new ChangeTrackingService(
      changeEventRepository,
      {} as any,
      undefined as any,
    );

    const saved = await service.appendChangeEventWithDetails({
      noticeNum: 1001,
      eventType: 'updated',
      eventHash: 'hash-atomic-1',
      changedFieldCount: 1,
      details: [
        {
          fieldPath: 'subject',
          changeType: 'modified',
          beforeValue: 'old',
          afterValue: 'new',
        },
      ],
      maxRetries: 2,
    });

    expect(saved).toMatchObject({ noticeNum: 1001, eventHeight: 4 });
    expect(changeEventRepository.manager.transaction).toHaveBeenCalledTimes(2);
    expect(inTxEventRepo.save).toHaveBeenCalledTimes(2);
    expect(inTxDetailRepo.save).toHaveBeenCalledTimes(1);
  });

  it('appends concurrent events with retries and preserves monotonic heights', async () => {
    let currentHeight = 3;
    let idSequence = 100;

    const inTxEventRepo = {
      findOne: jest
        .fn<(...args: any[]) => Promise<any>>()
        .mockImplementation(async () => ({
          eventHeight: currentHeight,
          eventHash: `prev-${currentHeight}`,
        })),
      create: jest.fn((payload: unknown) => payload),
      save: jest
        .fn<(...args: any[]) => Promise<any>>()
        .mockImplementation(async (event: any) => {
          const expectedNextHeight = currentHeight + 1;

          if (event.eventHeight !== expectedNextHeight) {
            const conflictError = new Error(
              'duplicate key value violates unique constraint',
            ) as Error & {
              code?: string;
              constraint?: string;
              detail?: string;
            };
            conflictError.code = '23505';
            conflictError.constraint =
              'idx_notice_change_events_notice_num_event_height_unique';
            conflictError.detail =
              'Key (notice_num, event_height) already exists';
            throw conflictError;
          }

          currentHeight = event.eventHeight;
          return {
            ...event,
            id: idSequence++,
          };
        }),
    };

    const inTxDetailRepo = {
      create: jest.fn((payload: unknown) => payload),
      save: jest
        .fn<(...args: any[]) => Promise<void>>()
        .mockResolvedValue(undefined),
    };

    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === NoticeChangeEvent) return inTxEventRepo;
        if (entity === NoticeChangeDetail) return inTxDetailRepo;
        throw new Error('Unexpected repository requested in test');
      }),
    };

    const changeEventRepository = {
      manager: {
        transaction: jest
          .fn<(fn: (manager: any) => Promise<any>) => Promise<any>>()
          .mockImplementation(async (fn) => fn(manager)),
      },
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    } as any;

    const service = new ChangeTrackingService(
      changeEventRepository,
      {} as any,
      undefined as any,
    );

    const appendInput = (hashSuffix: string) =>
      service.appendChangeEventWithDetails({
        noticeNum: 1001,
        eventType: 'updated',
        eventHash: `hash-${hashSuffix}`,
        changedFieldCount: 1,
        details: [
          {
            fieldPath: 'subject',
            changeType: 'modified',
            beforeValue: 'old',
            afterValue: 'new',
          },
        ],
        maxRetries: 3,
      });

    const savedEvents = await Promise.all([
      appendInput('a'),
      appendInput('b'),
      appendInput('c'),
    ]);

    const eventHeights = savedEvents.map((event) => event.eventHeight).sort();

    expect(eventHeights).toEqual([4, 5, 6]);
    expect(currentHeight).toBe(6);
    expect(changeEventRepository.manager.transaction).toHaveBeenCalledTimes(6);
    expect(inTxDetailRepo.save).toHaveBeenCalledTimes(3);
  });

  it('retries when sqlite transaction start conflicts occur', async () => {
    const inTxEventRepo = {
      findOne: jest
        .fn<(...args: any[]) => Promise<any>>()
        .mockResolvedValue({ eventHeight: 7, eventHash: 'prev-hash' }),
      create: jest.fn((payload: unknown) => payload),
      save: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
        id: 1007,
        noticeNum: 2219530,
        eventHeight: 8,
        eventHash: 'hash-sqlite-retry',
      }),
    };

    const inTxDetailRepo = {
      create: jest.fn((payload: unknown) => payload),
      save: jest
        .fn<(...args: any[]) => Promise<void>>()
        .mockResolvedValue(undefined),
    };

    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === NoticeChangeEvent) return inTxEventRepo;
        if (entity === NoticeChangeDetail) return inTxDetailRepo;
        throw new Error('Unexpected repository requested in test');
      }),
    };

    const sqliteTxStartError = Object.assign(
      new Error(
        'SQLITE_ERROR: cannot start a transaction within a transaction',
      ),
      {
        code: 'SQLITE_ERROR',
        driverError: {
          code: 'SQLITE_ERROR',
          message:
            'SQLITE_ERROR: cannot start a transaction within a transaction',
        },
      },
    );

    const changeEventRepository = {
      manager: {
        transaction: jest
          .fn<(fn: (manager: any) => Promise<any>) => Promise<any>>()
          .mockRejectedValueOnce(sqliteTxStartError)
          .mockImplementationOnce(async (fn) => fn(manager)),
      },
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    } as any;

    const service = new ChangeTrackingService(
      changeEventRepository,
      {} as any,
      undefined as any,
    );

    const savedPromise = service.appendChangeEventWithDetails({
      noticeNum: 2219530,
      eventType: 'updated',
      eventHash: 'hash-sqlite-retry',
      changedFieldCount: 1,
      details: [
        {
          fieldPath: 'subject',
          changeType: 'modified',
          beforeValue: 'old',
          afterValue: 'new',
        },
      ],
      maxRetries: 2,
    });

    await jest.advanceTimersByTimeAsync(20);
    const saved = await savedPromise;

    expect(saved).toMatchObject({ noticeNum: 2219530, eventHeight: 8 });
    expect(changeEventRepository.manager.transaction).toHaveBeenCalledTimes(2);
    expect(inTxEventRepo.save).toHaveBeenCalledTimes(1);
    expect(inTxDetailRepo.save).toHaveBeenCalledTimes(1);
  });

  it('reconstructs and validates a notice chain and computes a checkpoint hash', async () => {
    const bootstrapService = new ChangeTrackingService(
      {} as any,
      {} as any,
      undefined as any,
    );
    const createdDetectedAt = new Date('2026-07-03T00:00:00.000Z');
    const updatedDetectedAt = new Date('2026-07-03T01:00:00.000Z');
    const createdSnapshot = {
      num: '5001',
      subject: '초기 법률안',
      proposerCategory: null,
      committee: null,
      proposalReason: null,
      billNumber: null,
      proposer: null,
      proposalDate: null,
      contentCommittee: null,
      referralDate: null,
      noticePeriod: null,
      proposalSession: null,
      isDone: null,
      lifecycleStatus: 'active',
      sourceDeletedAt: null,
    };
    const updatedSnapshot = {
      ...createdSnapshot,
      committee: '법제사법위원회',
    };
    const createdBuilt = bootstrapService.buildDiffEvent({
      noticeNum: 5001,
      beforeSnapshot: null,
      afterSnapshot: createdSnapshot,
      detectedAt: createdDetectedAt,
      source: NoticeChangeSource.ARCHIVE_UPSERT,
    });
    const updatedBuilt = bootstrapService.buildDiffEvent({
      noticeNum: 5001,
      beforeSnapshot: createdSnapshot,
      afterSnapshot: updatedSnapshot,
      detectedAt: updatedDetectedAt,
      source: NoticeChangeSource.ARCHIVE_UPDATE_SOURCE_HTML,
    });

    const changeEventRepository = {
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn<(...args: any[]) => Promise<Array<{ noticeNum: number }>>>()
          .mockResolvedValue([{ noticeNum: 5001 }]),
      })),
      find: jest
        .fn<(...args: any[]) => Promise<any[]>>()
        .mockResolvedValueOnce([
          {
            id: 11,
            noticeNum: 5001,
            detectedAt: createdDetectedAt,
            eventType: 'created',
            source: NoticeChangeSource.ARCHIVE_UPSERT,
            eventHeight: 1,
            prevEventHash: null,
            eventHash: createdBuilt.eventHash,
            changedFieldCount: createdBuilt.diff.changedFieldCount,
            diffSummaryJson: createdBuilt.diff.diffSummaryJson,
            hashAlgo: 'sha256',
            canonVersion: 1,
          },
          {
            id: 12,
            noticeNum: 5001,
            detectedAt: updatedDetectedAt,
            eventType: 'updated',
            source: NoticeChangeSource.ARCHIVE_UPDATE_SOURCE_HTML,
            eventHeight: 2,
            prevEventHash: createdBuilt.eventHash,
            eventHash: updatedBuilt.eventHash,
            changedFieldCount: updatedBuilt.diff.changedFieldCount,
            diffSummaryJson: updatedBuilt.diff.diffSummaryJson,
            hashAlgo: 'sha256',
            canonVersion: 1,
          },
        ]),
    } as any;

    const changeDetailRepository = {
      find: jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue([
        ...createdBuilt.diff.details.map((detail, index) => ({
          id: 101 + index,
          eventId: 11,
          ...detail,
        })),
        ...updatedBuilt.diff.details.map((detail, index) => ({
          id: 201 + index,
          eventId: 12,
          ...detail,
        })),
      ]),
    } as any;

    const service = new ChangeTrackingService(
      changeEventRepository,
      changeDetailRepository,
      undefined as any,
      undefined as any,
    );

    const report = await service.runScheduledChainAudit('daily');

    expect(report.failureCount).toBe(0);
    expect(report.noticeCount).toBe(1);
    expect(report.eventCount).toBe(2);
    expect(report.checkpointRootHash).toHaveLength(64);
    expect(changeEventRepository.createQueryBuilder).toHaveBeenCalled();
  });
});
