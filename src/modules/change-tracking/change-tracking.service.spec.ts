import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';
import { ChangeTrackingService } from './change-tracking.service';
import {
  CHANGE_EVENT_TYPE,
  NoticeChangeEvent,
} from './notice-change-event.entity';
import { NoticeChangeDetail } from './notice-change-detail.entity';
import { NoticeChangeSource } from './notice-change-source.enum';
import {
  DEFAULT_TRACKED_FIELDS,
  getTrackedFieldsForCanonVersion,
} from './change-tracking-diff.utils';

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
        detectedAt: new Date('2026-01-01T00:00:00.000Z'),
        eventType: CHANGE_EVENT_TYPE.UPDATED,
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
        detectedAt: new Date('2026-01-01T00:01:00.000Z'),
        eventType: CHANGE_EVENT_TYPE.UPDATED,
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
        detectedAt: new Date('2026-01-01T00:02:00.000Z'),
        eventType: CHANGE_EVENT_TYPE.UPDATED,
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
        detectedAt: new Date('2026-01-01T00:03:00.000Z'),
        eventType: CHANGE_EVENT_TYPE.UPDATED,
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

  it('forwards invalidated source-missing events to change-notification batch payloads', async () => {
    const { service, notificationBatchService } = createService();

    await service.dispatchChangeNotification({
      event: {
        id: 8,
        noticeNum: 6001,
        detectedAt: new Date('2026-01-01T00:04:00.000Z'),
        eventType: CHANGE_EVENT_TYPE.INVALIDATED,
        source: NoticeChangeSource.ARCHIVE_SOURCE_MISSING,
        eventHash: 'hash-invalidated-source-missing',
        eventHeight: 3,
      } as any,
      subject: '삭제 감지 테스트 법률안',
      changedFields: ['lifecycleStatus', 'sourceDeletedAt'],
    });

    await service.flushQueuedChangeNotificationsNow();

    expect(
      notificationBatchService.processChangeNotificationBatch,
    ).toHaveBeenCalledTimes(1);

    const [payloads] = (
      notificationBatchService.processChangeNotificationBatch as jest.Mock
    ).mock.calls[0];

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      noticeNum: 6001,
      subject: '삭제 감지 테스트 법률안',
      eventType: CHANGE_EVENT_TYPE.INVALIDATED,
      source: NoticeChangeSource.ARCHIVE_SOURCE_MISSING,
      changedFields: ['lifecycleStatus', 'sourceDeletedAt'],
      eventHash: 'hash-invalidated-source-missing',
      eventHeight: 3,
      eventId: 8,
    });
  });

  it('skips created events because regular notice notifications already cover them', async () => {
    const { service, notificationBatchService } = createService();

    await service.dispatchChangeNotification({
      event: {
        id: 5,
        noticeNum: 4001,
        eventType: CHANGE_EVENT_TYPE.CREATED,
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
        eventType: CHANGE_EVENT_TYPE.UPDATED,
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
        eventType: CHANGE_EVENT_TYPE.UPDATED,
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
      eventType: CHANGE_EVENT_TYPE.UPDATED,
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
    expect(inTxEventRepo.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ canonVersion: 2 }),
    );
    expect(inTxEventRepo.save).toHaveBeenCalledTimes(2);
    expect(inTxDetailRepo.save).toHaveBeenCalledTimes(1);
  });

  it('skips appending when latest event payload and details are identical', async () => {
    const latestEvent = {
      id: 77,
      noticeNum: 2219775,
      eventType: CHANGE_EVENT_TYPE.UPDATED,
      source: NoticeChangeSource.ARCHIVE_UPDATE_NSM_HTML_AND_DETAIL,
      eventHeight: 9,
      eventHash: 'hash-existing',
      changedFieldCount: 1,
      diffSummaryJson: JSON.stringify({
        changedFields: ['proposalReason'],
        total: 1,
      }),
    } as any;

    const changeEventRepository = {
      findOne: jest
        .fn<(...args: any[]) => Promise<any>>()
        .mockResolvedValue(latestEvent),
      manager: {
        transaction: jest
          .fn<(fn: (manager: any) => Promise<any>) => Promise<any>>()
          .mockImplementation(async (fn) => fn({})),
      },
    } as any;

    const changeDetailRepository = {
      find: jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue([
        {
          eventId: 77,
          fieldPath: 'proposalReason',
          changeType: 'modified',
          beforeValue: null,
          afterValue: '사유 본문',
          beforeHash: null,
          afterHash: 'hash-after',
        },
      ]),
    } as any;

    const service = new ChangeTrackingService(
      changeEventRepository,
      changeDetailRepository,
      undefined as any,
    );

    const saved = await service.appendChangeEventWithDetails({
      noticeNum: 2219775,
      eventType: CHANGE_EVENT_TYPE.UPDATED,
      source: NoticeChangeSource.ARCHIVE_UPDATE_NSM_HTML_AND_DETAIL,
      eventHash: 'hash-new-but-should-skip',
      changedFieldCount: 1,
      diffSummaryJson: JSON.stringify({
        changedFields: ['proposalReason'],
        total: 1,
      }),
      details: [
        {
          fieldPath: 'proposalReason',
          changeType: 'modified',
          beforeValue: null,
          afterValue: '사유 본문',
          beforeHash: null,
          afterHash: 'hash-after',
        },
      ],
    });

    expect(saved).toBe(latestEvent);
    expect(changeEventRepository.findOne).toHaveBeenCalledTimes(1);
    expect(changeDetailRepository.find).toHaveBeenCalledTimes(1);
    expect(changeEventRepository.manager.transaction).not.toHaveBeenCalled();
  });

  it('returns null when the latest field record clears proposalReason even if an older record was non-empty', async () => {
    const rowQueue = [{ afterValue: '과거 제안이유' }, { afterValue: null }];

    const qb = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawOne: jest
        .fn<(...args: any[]) => Promise<{ afterValue: string | null }>>()
        .mockImplementation(async () => rowQueue.shift() ?? null),
    };

    const service = new ChangeTrackingService(
      {} as any,
      {
        createQueryBuilder: jest.fn().mockReturnValue(qb),
      } as any,
      undefined as any,
    );

    const latestNonEmpty = await service.getLatestFieldAfterValue(
      3001,
      'proposalReason',
    );
    const latestFieldValue = await service.getLatestFieldValue(
      3001,
      'proposalReason',
    );

    expect(latestNonEmpty).toBe('과거 제안이유');
    expect(latestFieldValue).toBeNull();
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
        eventType: CHANGE_EVENT_TYPE.UPDATED,
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
      eventType: CHANGE_EVENT_TYPE.UPDATED,
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
      num: 5001,
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
            eventType: CHANGE_EVENT_TYPE.CREATED,
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
            eventType: CHANGE_EVENT_TYPE.UPDATED,
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

  it('accepts legacy canonVersion=1 hash drift when other invariants match', async () => {
    const bootstrapService = new ChangeTrackingService(
      {} as any,
      {} as any,
      undefined as any,
    );
    const detectedAt = new Date('2026-07-03T00:00:00.000Z');
    const snapshot = {
      num: 7001,
      subject: '구버전 해시 검증',
      proposerCategory: null,
      committee: null,
      proposalReason: '문단 1\n문단 2',
      billNumber: null,
      proposer: null,
      proposalDate: null,
      contentCommittee: null,
      referralDate: null,
      noticePeriod: null,
      proposalSession: null,
      isDone: false,
      lifecycleStatus: 'active',
      sourceDeletedAt: null,
    };
    const built = bootstrapService.buildDiffEvent({
      noticeNum: 7001,
      beforeSnapshot: null,
      afterSnapshot: snapshot,
      detectedAt,
      source: NoticeChangeSource.ARCHIVE_UPSERT,
    });

    const changeEventRepository = {
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn<(...args: any[]) => Promise<Array<{ noticeNum: number }>>>()
          .mockResolvedValue([{ noticeNum: 7001 }]),
      })),
      find: jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue([
        {
          id: 31,
          noticeNum: 7001,
          detectedAt,
          eventType: CHANGE_EVENT_TYPE.CREATED,
          source: NoticeChangeSource.ARCHIVE_UPSERT,
          eventHeight: 1,
          prevEventHash: null,
          eventHash: 'legacy-v1-hash-drift',
          changedFieldCount: built.diff.changedFieldCount,
          diffSummaryJson: built.diff.diffSummaryJson,
          hashAlgo: 'sha256',
          canonVersion: 1,
        },
      ]),
    } as any;

    const changeDetailRepository = {
      find: jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue(
        built.diff.details.map((detail, index) => ({
          id: 301 + index,
          eventId: 31,
          ...detail,
        })),
      ),
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
    expect(report.eventCount).toBe(1);
  });

  it('accepts legacy prev_hash drift when the event remains canonically compatible', async () => {
    const bootstrapService = new ChangeTrackingService(
      {} as any,
      {} as any,
      undefined as any,
    );
    const firstDetectedAt = new Date('2026-07-01T00:00:00.000Z');
    const secondDetectedAt = new Date('2026-07-02T00:00:00.000Z');
    const firstSnapshot = {
      num: 7101,
      subject: '레거시 선행 이벤트',
      proposerCategory: '의원',
      committee: '정무위원회',
      proposalReason: '문단 1\n문단 2',
      billNumber: null,
      proposer: null,
      proposalDate: null,
      contentCommittee: null,
      referralDate: null,
      noticePeriod: null,
      proposalSession: null,
      isDone: false,
      lifecycleStatus: 'active',
      sourceDeletedAt: null,
    };
    const firstBuilt = bootstrapService.buildDiffEvent({
      noticeNum: 7101,
      beforeSnapshot: null,
      afterSnapshot: firstSnapshot,
      detectedAt: firstDetectedAt,
      source: NoticeChangeSource.ARCHIVE_UPSERT,
      trackedFields: getTrackedFieldsForCanonVersion(1),
      canonVersion: 1,
    });

    const secondSnapshot = {
      ...firstSnapshot,
      subject: '레거시 이후 이벤트',
    };
    const secondBuilt = bootstrapService.buildDiffEvent({
      noticeNum: 7101,
      beforeSnapshot: firstSnapshot,
      afterSnapshot: secondSnapshot,
      detectedAt: secondDetectedAt,
      source: NoticeChangeSource.ARCHIVE_UPSERT,
      trackedFields: getTrackedFieldsForCanonVersion(1),
      canonVersion: 1,
    });

    const changeEventRepository = {
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn<(...args: any[]) => Promise<Array<{ noticeNum: number }>>>()
          .mockResolvedValue([{ noticeNum: 7101 }]),
      })),
      find: jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue([
        {
          id: 71,
          noticeNum: 7101,
          detectedAt: firstDetectedAt,
          eventType: CHANGE_EVENT_TYPE.CREATED,
          source: NoticeChangeSource.ARCHIVE_UPSERT,
          eventHeight: 1,
          prevEventHash: null,
          eventHash: 'legacy-first-hash-drift',
          changedFieldCount: firstBuilt.diff.changedFieldCount,
          diffSummaryJson: firstBuilt.diff.diffSummaryJson,
          hashAlgo: 'sha256',
          canonVersion: 1,
        },
        {
          id: 72,
          noticeNum: 7101,
          detectedAt: secondDetectedAt,
          eventType: CHANGE_EVENT_TYPE.UPDATED,
          source: NoticeChangeSource.ARCHIVE_UPSERT,
          eventHeight: 2,
          prevEventHash: 'legacy-stale-prev-hash',
          eventHash: 'legacy-second-hash-drift',
          changedFieldCount: secondBuilt.diff.changedFieldCount,
          diffSummaryJson: secondBuilt.diff.diffSummaryJson,
          hashAlgo: 'sha256',
          canonVersion: 1,
        },
      ]),
    } as any;

    const changeDetailRepository = {
      find: jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue([
        ...firstBuilt.diff.details.map((detail, index) => ({
          id: 701 + index,
          eventId: 71,
          ...detail,
        })),
        ...secondBuilt.diff.details.map((detail, index) => ({
          id: 721 + index,
          eventId: 72,
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
  });

  it('follows the stored hash after a legacy-compatible event', async () => {
    const bootstrapService = new ChangeTrackingService(
      {} as any,
      {} as any,
      undefined as any,
    );
    const firstDetectedAt = new Date('2026-07-05T00:00:00.000Z');
    const secondDetectedAt = new Date('2026-07-06T00:00:00.000Z');
    const firstSnapshot = {
      num: 7102,
      contentId: 'legacy-content-id',
      subject: '레거시 이벤트',
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
      isDone: false,
      lifecycleStatus: 'active',
      sourceDeletedAt: null,
    };
    const secondSnapshot = {
      ...firstSnapshot,
      subject: '후속 이벤트',
    };
    const firstBuilt = bootstrapService.buildDiffEvent({
      noticeNum: 7102,
      beforeSnapshot: null,
      afterSnapshot: firstSnapshot,
      detectedAt: firstDetectedAt,
      source: NoticeChangeSource.ARCHIVE_UPSERT,
      trackedFields: getTrackedFieldsForCanonVersion(1),
      canonVersion: 1,
    });
    const secondBuilt = bootstrapService.buildDiffEvent({
      noticeNum: 7102,
      beforeSnapshot: firstSnapshot,
      afterSnapshot: secondSnapshot,
      detectedAt: secondDetectedAt,
      source: NoticeChangeSource.ARCHIVE_UPSERT,
      trackedFields: getTrackedFieldsForCanonVersion(1),
      canonVersion: 1,
    });
    const storedFirstHash = 'legacy-stored-first-hash';

    const changeEventRepository = {
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn<(...args: any[]) => Promise<Array<{ noticeNum: number }>>>()
          .mockResolvedValue([{ noticeNum: 7102 }]),
      })),
      find: jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue([
        {
          id: 81,
          noticeNum: 7102,
          detectedAt: firstDetectedAt,
          eventType: CHANGE_EVENT_TYPE.CREATED,
          source: NoticeChangeSource.ARCHIVE_UPSERT,
          eventHeight: 1,
          prevEventHash: null,
          eventHash: storedFirstHash,
          changedFieldCount: firstBuilt.diff.changedFieldCount,
          diffSummaryJson: firstBuilt.diff.diffSummaryJson,
          hashAlgo: 'sha256',
          canonVersion: 1,
        },
        {
          id: 82,
          noticeNum: 7102,
          detectedAt: secondDetectedAt,
          eventType: CHANGE_EVENT_TYPE.UPDATED,
          source: NoticeChangeSource.ARCHIVE_UPSERT,
          eventHeight: 2,
          prevEventHash: storedFirstHash,
          eventHash: secondBuilt.eventHash,
          changedFieldCount: secondBuilt.diff.changedFieldCount,
          diffSummaryJson: secondBuilt.diff.diffSummaryJson,
          hashAlgo: 'sha256',
          canonVersion: 1,
        },
      ]),
    } as any;
    const changeDetailRepository = {
      find: jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue([
        ...firstBuilt.diff.details.map((detail, index) => ({
          id: 801 + index,
          eventId: 81,
          ...detail,
        })),
        ...secondBuilt.diff.details.map((detail, index) => ({
          id: 821 + index,
          eventId: 82,
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
  });

  it('replays proposalReason line-layout changes with versioned semantics', () => {
    const service = new ChangeTrackingService(
      {} as any,
      {} as any,
      undefined as any,
    );
    const beforeSnapshot = {
      proposalReason: '첫 줄 둘째 줄 셋째 줄',
    };
    const afterSnapshot = {
      proposalReason: '첫 줄\n둘째 줄\n\n셋째 줄',
    };

    const legacy = service.buildDiffEvent({
      noticeNum: 7003,
      beforeSnapshot,
      afterSnapshot,
      trackedFields: ['proposalReason'],
      canonVersion: 1,
    });
    const current = service.buildDiffEvent({
      noticeNum: 7003,
      beforeSnapshot,
      afterSnapshot,
      trackedFields: ['proposalReason'],
      canonVersion: 2,
    });

    expect(legacy.shouldAppend).toBe(true);
    expect(legacy.diff.details).toEqual([
      expect.objectContaining({ fieldPath: 'proposalReason' }),
    ]);
    expect(current.shouldAppend).toBe(false);
    expect(current.diff.details).toEqual([]);
  });

  it('selects tracked fields from canonVersion when callers omit them', () => {
    const service = new ChangeTrackingService(
      {} as any,
      {} as any,
      undefined as any,
    );
    const beforeSnapshot = {
      num: 7004,
      contentId: null,
      subject: '동일 법률안',
    };
    const afterSnapshot = {
      ...beforeSnapshot,
      contentId: 'PRC_7004',
    };

    const legacy = service.buildDiffEvent({
      noticeNum: 7004,
      beforeSnapshot,
      afterSnapshot,
      canonVersion: 1,
    });
    const current = service.buildDiffEvent({
      noticeNum: 7004,
      beforeSnapshot,
      afterSnapshot,
      canonVersion: 2,
    });

    expect(legacy.shouldAppend).toBe(false);
    expect(current.shouldAppend).toBe(true);
    expect(current.diff.details).toEqual([
      expect.objectContaining({ fieldPath: 'contentId' }),
    ]);
  });

  it('keeps strict hash validation for canonVersion>1', async () => {
    const bootstrapService = new ChangeTrackingService(
      {} as any,
      {} as any,
      undefined as any,
    );
    const detectedAt = new Date('2026-07-03T00:00:00.000Z');
    const snapshot = {
      num: 7002,
      subject: '신버전 해시 검증',
      proposerCategory: null,
      committee: null,
      proposalReason: '문단 1\n문단 2',
      billNumber: null,
      proposer: null,
      proposalDate: null,
      contentCommittee: null,
      referralDate: null,
      noticePeriod: null,
      proposalSession: null,
      isDone: false,
      lifecycleStatus: 'active',
      sourceDeletedAt: null,
    };
    const built = bootstrapService.buildDiffEvent({
      noticeNum: 7002,
      beforeSnapshot: null,
      afterSnapshot: snapshot,
      detectedAt,
      source: NoticeChangeSource.ARCHIVE_UPSERT,
    });

    const changeEventRepository = {
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn<(...args: any[]) => Promise<Array<{ noticeNum: number }>>>()
          .mockResolvedValue([{ noticeNum: 7002 }]),
      })),
      find: jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue([
        {
          id: 41,
          noticeNum: 7002,
          detectedAt,
          eventType: CHANGE_EVENT_TYPE.CREATED,
          source: NoticeChangeSource.ARCHIVE_UPSERT,
          eventHeight: 1,
          prevEventHash: null,
          eventHash: 'canon-v2-hash-drift',
          changedFieldCount: built.diff.changedFieldCount,
          diffSummaryJson: built.diff.diffSummaryJson,
          hashAlgo: 'sha256',
          canonVersion: 2,
        },
      ]),
    } as any;

    const changeDetailRepository = {
      find: jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue(
        built.diff.details.map((detail, index) => ({
          id: 401 + index,
          eventId: 41,
          ...detail,
        })),
      ),
    } as any;

    const service = new ChangeTrackingService(
      changeEventRepository,
      changeDetailRepository,
      undefined as any,
      undefined as any,
    );

    const report = await service.runScheduledChainAudit('daily');

    expect(report.failureCount).toBe(1);
    expect(report.failures[0]?.code).toBe('event_hash_mismatch');
  });

  it('replays pre-versioned v1 chains that recorded contentId details without v2 snapshot canonicalization', async () => {
    const bootstrapService = new ChangeTrackingService(
      {} as any,
      {} as any,
      undefined as any,
    );
    const firstDetectedAt = new Date('2026-07-07T00:00:00.000Z');
    const secondDetectedAt = new Date('2026-07-08T00:00:00.000Z');
    // Pre-versioned era (contentId tracked, canonVersion column absent):
    // events were diffed with DEFAULT_TRACKED_FIELDS but hashed from raw
    // snapshots, so sponsor-suffix subjects and dotted dates were never
    // canonicalized. The audit must reproduce exactly that.
    const firstSnapshot = {
      num: 7201,
      contentId: 'PRC_7201',
      subject: '무결성 보존에 관한 법률안(김철수 의원 등 10인)',
      proposerCategory: '의원',
      committee: '정무위원회',
      proposalReason: '문단 1\n문단 2',
      billNumber: null,
      proposer: null,
      proposalDate: '2026. 7. 7.',
      contentCommittee: null,
      referralDate: null,
      noticePeriod: null,
      proposalSession: null,
      isDone: false,
      lifecycleStatus: 'active',
      sourceDeletedAt: null,
    };
    const firstBuilt = bootstrapService.buildDiffEvent({
      noticeNum: 7201,
      beforeSnapshot: null,
      afterSnapshot: firstSnapshot,
      detectedAt: firstDetectedAt,
      source: NoticeChangeSource.ARCHIVE_UPSERT,
      trackedFields: DEFAULT_TRACKED_FIELDS,
      canonVersion: 1,
    });

    const secondSnapshot = {
      ...firstSnapshot,
      subject: '무결성 보존에 관한 법률안(김철수 의원 등 10인)(수정)',
    };
    const secondBuilt = bootstrapService.buildDiffEvent({
      noticeNum: 7201,
      beforeSnapshot: firstSnapshot,
      afterSnapshot: secondSnapshot,
      detectedAt: secondDetectedAt,
      source: NoticeChangeSource.ARCHIVE_UPSERT,
      trackedFields: DEFAULT_TRACKED_FIELDS,
      canonVersion: 1,
    });

    const changeEventRepository = {
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn<(...args: any[]) => Promise<Array<{ noticeNum: number }>>>()
          .mockResolvedValue([{ noticeNum: 7201 }]),
      })),
      find: jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue([
        {
          id: 91,
          noticeNum: 7201,
          detectedAt: firstDetectedAt,
          eventType: CHANGE_EVENT_TYPE.CREATED,
          source: NoticeChangeSource.ARCHIVE_UPSERT,
          eventHeight: 1,
          prevEventHash: null,
          eventHash: firstBuilt.eventHash,
          changedFieldCount: firstBuilt.diff.changedFieldCount,
          diffSummaryJson: firstBuilt.diff.diffSummaryJson,
          hashAlgo: 'sha256',
          canonVersion: 1,
        },
        {
          id: 92,
          noticeNum: 7201,
          detectedAt: secondDetectedAt,
          eventType: CHANGE_EVENT_TYPE.UPDATED,
          source: NoticeChangeSource.ARCHIVE_UPSERT,
          eventHeight: 2,
          prevEventHash: firstBuilt.eventHash,
          eventHash: secondBuilt.eventHash,
          changedFieldCount: secondBuilt.diff.changedFieldCount,
          diffSummaryJson: secondBuilt.diff.diffSummaryJson,
          hashAlgo: 'sha256',
          canonVersion: 1,
        },
      ]),
    } as any;
    const changeDetailRepository = {
      find: jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue([
        ...firstBuilt.diff.details.map((detail, index) => ({
          id: 901 + index,
          eventId: 91,
          ...detail,
        })),
        ...secondBuilt.diff.details.map((detail, index) => ({
          id: 921 + index,
          eventId: 92,
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
  });

  it('never canonicalizes v1 snapshots even when the subject or date would change under v2 rules', async () => {
    const bootstrapService = new ChangeTrackingService(
      {} as any,
      {} as any,
      undefined as any,
    );
    const detectedAt = new Date('2026-07-09T00:00:00.000Z');
    const snapshot = {
      num: 7202,
      subject: '무결성 보존에 관한 법률안(박영희 의원 등 15인)',
      proposerCategory: '의원',
      committee: null,
      proposalReason: '문단 1\n문단 2',
      billNumber: null,
      proposer: null,
      proposalDate: '2026. 7. 9.',
      contentCommittee: null,
      referralDate: null,
      noticePeriod: null,
      proposalSession: null,
      isDone: false,
      lifecycleStatus: 'active',
      sourceDeletedAt: null,
    };
    const built = bootstrapService.buildDiffEvent({
      noticeNum: 7202,
      beforeSnapshot: null,
      afterSnapshot: snapshot,
      detectedAt,
      source: NoticeChangeSource.ARCHIVE_UPSERT,
      trackedFields: getTrackedFieldsForCanonVersion(1),
      canonVersion: 1,
    });

    const changeEventRepository = {
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn<(...args: any[]) => Promise<Array<{ noticeNum: number }>>>()
          .mockResolvedValue([{ noticeNum: 7202 }]),
      })),
      find: jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue([
        {
          id: 93,
          noticeNum: 7202,
          detectedAt,
          eventType: CHANGE_EVENT_TYPE.CREATED,
          source: NoticeChangeSource.ARCHIVE_UPSERT,
          eventHeight: 1,
          prevEventHash: null,
          eventHash: built.eventHash,
          changedFieldCount: built.diff.changedFieldCount,
          diffSummaryJson: built.diff.diffSummaryJson,
          hashAlgo: 'sha256',
          canonVersion: 1,
        },
      ]),
    } as any;
    const changeDetailRepository = {
      find: jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue(
        built.diff.details.map((detail, index) => ({
          id: 931 + index,
          eventId: 93,
          ...detail,
        })),
      ),
    } as any;

    const service = new ChangeTrackingService(
      changeEventRepository,
      changeDetailRepository,
      undefined as any,
      undefined as any,
    );

    const report = await service.runScheduledChainAudit('daily');

    expect(report.failureCount).toBe(0);
  });
});
