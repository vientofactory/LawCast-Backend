import { createHash } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { ApiController } from '../controllers/api.controller';
import { WebhookService } from '../modules/webhook/webhook.service';
import { CrawlingService } from '../modules/crawling/crawling.service';
import { HealthCheckService } from '../modules/health/health-check.service';
import { WebhookRegistrationService } from '../modules/notification/webhook-registration.service';
import { WebPushRegistrationService } from '../modules/notification/web-push-registration.service';
import { WebPushSubscriptionService } from '../modules/notification/web-push-subscription.service';
import { WebPushNotificationService } from '../modules/notification/web-push-notification.service';
import { BatchProcessingService } from '../modules/shared/batch-processing.service';
import {
  LEGACY_GENESIS_SOURCE,
  NoticeArchiveService,
} from '../modules/notice/notice-archive.service';
import { NoticesQueryService } from '../modules/crawling/notices-query.service';
import { NoticeSearchService } from '../modules/crawling/notice-search.service';
import { RuntimeStatsService } from '../modules/health/runtime-stats.service';
import { ArchiveSyncService } from '../modules/crawling/archive-sync.service';
import { PackagesService } from '../modules/shared/packages.service';
import { ChangeTrackingService } from '../modules/change-tracking/change-tracking.service';
import { getTrackedFieldsForCanonVersion } from '../modules/change-tracking/change-tracking-diff.utils';
import { NoticeChangeSource } from '../modules/change-tracking/notice-change-source.enum';
import { NoticeArchive } from '../modules/notice/notice-archive.entity';
import { NoticeArchiveIntegrityCheck } from '../modules/notice/notice-archive-integrity-check.entity';
import { NoticeArchiveIntegrityState } from '../modules/notice/notice-archive-integrity-state.entity';
import { NoticeArchiveArtifactSupport } from '../modules/notice/utils/notice-archive-artifact-support';
import {
  CHANGE_EVENT_TYPE,
  NoticeChangeEvent,
  type ChangeEventType,
} from '../modules/change-tracking/notice-change-event.entity';
import {
  NoticeChangeDetail,
  type ChangeDetailType,
} from '../modules/change-tracking/notice-change-detail.entity';
import { DataSource, In, Repository } from 'typeorm';

type SeedDetail = {
  fieldPath: string;
  changeType: ChangeDetailType;
  beforeValue?: string | null;
  afterValue?: string | null;
};

describe('Diffchain API (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let archiveRepository: Repository<NoticeArchive>;
  let changeTrackingService: ChangeTrackingService;

  const mockCrawlingService = {
    getRecentNotices: jest.fn().mockResolvedValue([]),
    getCacheInfo: jest.fn().mockResolvedValue({
      size: 0,
      lastUpdated: null,
      maxSize: 10,
      isInitialized: true,
    }),
    getOllamaMetrics: jest.fn().mockResolvedValue({
      enabled: false,
      configured: false,
      model: null,
      summary: {
        total: 0,
        success: 0,
        failed: 0,
        skipped: 0,
        successRate: 0,
      },
      health: {
        status: 'disabled',
        lastCheckedAt: null,
        lastLatencyMs: null,
        error: null,
      },
    }),
  };

  const mockHealthCheckService = {
    getApiHealthPayload: jest.fn().mockResolvedValue({ status: 'healthy' }),
    getOllamaMetrics: jest.fn().mockResolvedValue({
      enabled: false,
      configured: false,
      model: null,
      summary: {
        total: 0,
        success: 0,
        failed: 0,
        skipped: 0,
        successRate: 0,
      },
      health: {
        status: 'disabled',
        lastCheckedAt: null,
        lastLatencyMs: null,
        error: null,
      },
    }),
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          autoLoadEntities: true,
          synchronize: true,
          dropSchema: true,
        }),
        TypeOrmModule.forFeature([
          NoticeArchive,
          NoticeChangeEvent,
          NoticeChangeDetail,
          NoticeArchiveIntegrityCheck,
          NoticeArchiveIntegrityState,
        ]),
      ],
      controllers: [ApiController],
      providers: [
        NoticeArchiveService,
        NoticesQueryService,
        ChangeTrackingService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'nodeEnv') return 'test';
              return undefined;
            }),
          },
        },
        {
          provide: WebhookService,
          useValue: {
            findByUrl: jest.fn(),
            create: jest.fn(),
            remove: jest.fn(),
            getDetailedStats: jest.fn().mockResolvedValue({}),
          },
        },
        { provide: CrawlingService, useValue: mockCrawlingService },
        { provide: HealthCheckService, useValue: mockHealthCheckService },
        {
          provide: WebhookRegistrationService,
          useValue: {
            registerWebhook: jest.fn(),
          },
        },
        {
          provide: WebPushRegistrationService,
          useValue: {
            registerSubscription: jest.fn(),
            unregisterSubscription: jest.fn(),
          },
        },
        {
          provide: WebPushSubscriptionService,
          useValue: {
            getSubscriptions: jest.fn(),
            create: jest.fn(),
            remove: jest.fn(),
          },
        },
        {
          provide: WebPushNotificationService,
          useValue: {
            getPublicConfig: jest.fn().mockReturnValue({ publicKey: 'test' }),
            sendNotification: jest.fn(),
          },
        },
        {
          provide: BatchProcessingService,
          useValue: {
            getBatchJobStatus: jest
              .fn()
              .mockReturnValue({ jobCount: 0, jobIds: [] }),
          },
        },
        {
          provide: NoticeSearchService,
          useValue: {
            searchNotices: jest.fn(),
          },
        },
        {
          provide: RuntimeStatsService,
          useValue: {
            getRuntimeStats: jest.fn().mockResolvedValue({}),
            getAggregatedStats: jest.fn().mockResolvedValue({}),
          },
        },
        {
          provide: ArchiveSyncService,
          useValue: {
            getIsDoneSyncStatus: jest.fn().mockReturnValue({
              status: 'idle',
              lastRunAt: null,
              lastResult: null,
              lastError: null,
            }),
          },
        },
        {
          provide: PackagesService,
          useValue: {
            getPackages: jest.fn().mockReturnValue([]),
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    dataSource = moduleRef.get(DataSource);
    archiveRepository = dataSource.getRepository(NoticeArchive);
    changeTrackingService = moduleRef.get(ChangeTrackingService);

    await seedFixtures();
  });

  afterAll(async () => {
    await app?.close();
    await moduleRef?.close();
  });

  it('returns the notice change timeline with detail rows in descending revision order', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/notices/1003/changes?limit=10')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.noticeNum).toBe(1003);
    expect(response.body.data.count).toBe(3);
    expect(
      response.body.data.items.map((item: any) => item.eventHeight),
    ).toEqual([3, 2, 1]);
    expect(response.body.data.items[2].source).toBe(LEGACY_GENESIS_SOURCE);
    expect(response.body.data.items[1].details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldPath: 'subject',
          beforeValue: '의안 1003 최초 제목',
          afterValue: '의안 1003 수정 제목',
        }),
      ]),
    );
  });

  it('applies historical revision overlay and exposes the legacy genesis boundary on detail responses', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/notices/1003/detail?rev=1')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.notice.subject).toBe('의안 1003 최초 제목');
    expect(response.body.data.originalContent.proposalReason).toBe(
      '의안 1003 최초 제안 이유',
    );
    expect(response.body.data.revision).toEqual(
      expect.objectContaining({
        requestedRev: 1,
        resolvedRev: 1,
        headRev: 3,
        hasDiffchain: true,
        isHistorical: true,
        hasLegacyGenesisBoundary: true,
      }),
    );
    expect(response.body.data.revision.legacyGenesisBoundaryAt).toBe(
      '2026-07-01T00:00:00.000Z',
    );
  });

  it('omits changeEventCount for genesis-only notices while preserving real counts in archive list results', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/notices/archive?page=1&limit=10')
      .expect(200);

    expect(response.body.success).toBe(true);

    const items = response.body.data.items as Array<Record<string, unknown>>;
    const genesisOnly = items.find((item) => item.num === 1001);
    const singleComparable = items.find((item) => item.num === 1002);
    const multiComparable = items.find((item) => item.num === 1003);

    expect(genesisOnly).toBeDefined();
    expect(genesisOnly).not.toHaveProperty('changeEventCount');
    expect(singleComparable).toMatchObject({ num: 1002, changeEventCount: 2 });
    expect(multiComparable).toMatchObject({ num: 1003, changeEventCount: 3 });
  });

  it('reads diffchain rows from the real SQLite DB and validates the runtime chain audit', async () => {
    const eventRepository = dataSource.getRepository(NoticeChangeEvent);
    const detailRepository = dataSource.getRepository(NoticeChangeDetail);

    const events = await eventRepository.find({
      where: { noticeNum: 1003 },
      order: { eventHeight: 'ASC', id: 'ASC' },
    });

    expect(events).toHaveLength(3);
    const eventIds = events.map((event) => event.id);
    const details = await detailRepository.find({
      where: { eventId: In(eventIds) },
      order: { id: 'ASC' },
    });

    expect(details.length).toBeGreaterThan(0);
    expect(events.map((event) => event.eventHash.length)).toEqual([64, 64, 64]);

    const report = await changeTrackingService.runScheduledChainAudit('daily');

    expect(report.failureCount).toBe(0);
    expect(report.failures).toEqual([]);
    expect(report.noticeCount).toBeGreaterThanOrEqual(1);
  });

  it('does not flag a legacy canon-version hash drift as a runtime integrity failure', async () => {
    const bootstrapService = new ChangeTrackingService(
      {} as any,
      {} as any,
      undefined as any,
    );
    const detectedAt = new Date('2026-07-05T00:00:00.000Z');
    const snapshot = {
      num: 2001,
      subject: '레거시 해시 회귀 검증',
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
    const built = bootstrapService.buildDiffEvent({
      noticeNum: 2001,
      beforeSnapshot: null,
      afterSnapshot: snapshot,
      detectedAt,
      source: NoticeChangeSource.ARCHIVE_UPSERT,
      canonVersion: 1,
    });

    const changeEventRepository = {
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([{ noticeNum: 2001 }]),
      })),
      find: jest.fn().mockResolvedValue([
        {
          id: 91,
          noticeNum: 2001,
          detectedAt,
          eventType: CHANGE_EVENT_TYPE.CREATED,
          source: NoticeChangeSource.ARCHIVE_UPSERT,
          eventHeight: 1,
          prevEventHash: null,
          eventHash: 'legacy-runtime-hash-drift',
          changedFieldCount: built.diff.changedFieldCount,
          diffSummaryJson: built.diff.diffSummaryJson,
          hashAlgo: 'sha256',
          canonVersion: 1,
        },
      ]),
    } as any;

    const changeDetailRepository = {
      find: jest.fn().mockResolvedValue(
        built.diff.details.map((detail, index) => ({
          id: 901 + index,
          eventId: 91,
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
    const noticeReport = report.failures.find(
      (failure) => failure.noticeNum === 2001,
    );
    expect(noticeReport).toBeUndefined();
  });

  it('retries a transient SQLite transaction-state conflict during integrity rescan', async () => {
    const archiveRepo = {
      find: jest.fn().mockResolvedValue([
        {
          id: 1,
          noticeNum: 4001,
          sourceHtml: '<html><body>무결성 재검증</body></html>',
          sourceHtmlSha256: createHash('sha256')
            .update('<html><body>무결성 재검증</body></html>')
            .digest('hex'),
          integrityCheckPassed: true,
          integrityVerifiedAt: new Date('2026-07-05T00:00:00.000Z'),
        },
      ]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    } as any;

    const integrityCheckRepository = {
      save: jest.fn().mockResolvedValue({ id: 1001 }),
      create: jest.fn().mockImplementation((input) => input),
    } as any;

    const integrityStateRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 11,
        failureStreak: 0,
        lastPassedAt: null,
      }),
      update: jest
        .fn()
        .mockRejectedValueOnce(
          new Error(
            'Transaction is not started yet, start transaction before committing or rolling it back.',
          ),
        )
        .mockResolvedValue({ affected: 1 }),
      insert: jest.fn().mockResolvedValue({ raw: {} }),
    } as any;

    const support = new NoticeArchiveArtifactSupport(
      archiveRepo,
      integrityCheckRepository,
      integrityStateRepository,
    );

    const result = await support.runIntegrityScan(10);

    expect(result.scanned).toBe(1);
    expect(result.failed).toBe(0);
    expect(integrityStateRepository.update).toHaveBeenCalled();
  });

  it('treats height=2 and above as comparable revisions and computes the matching summary', async () => {
    const [changesResponse, summaryResponse] = await Promise.all([
      request(app.getHttpServer())
        .get(
          '/api/notices/changes?page=1&limit=10&excludeLegacyGenesisSource=true&comparableOnly=true',
        )
        .expect(200),
      request(app.getHttpServer())
        .get('/api/notices/changes/summary')
        .expect(200),
    ]);

    expect(changesResponse.body.success).toBe(true);
    expect(changesResponse.body.data.total).toBe(3);
    expect(changesResponse.body.data.items).toHaveLength(3);
    expect(
      changesResponse.body.data.items.map((item: any) => item.noticeNum),
    ).toEqual([1003, 1003, 1002]);
    expect(
      changesResponse.body.data.items.map((item: any) => item.eventHeight),
    ).toEqual([3, 2, 2]);
    expect(
      changesResponse.body.data.items.every(
        (item: any) => item.source !== LEGACY_GENESIS_SOURCE,
      ),
    ).toBe(true);

    expect(summaryResponse.body.success).toBe(true);
    expect(summaryResponse.body.data).toEqual({
      comparableEventTotal: 3,
      comparableNoticeCount: 2,
    });
  });

  async function seedFixtures(): Promise<void> {
    const noticeStateByNum = new Map<number, Record<string, unknown>>();

    await archiveRepository.save([
      createArchiveNotice({
        noticeNum: 1001,
        subject: '의안 1001 최초 제목',
        proposalReason: '의안 1001 최초 제안 이유',
      }),
      createArchiveNotice({
        noticeNum: 1002,
        subject: '의안 1002 수정 제목',
        proposalReason: '의안 1002 최초 제안 이유',
      }),
      createArchiveNotice({
        noticeNum: 1003,
        subject: '의안 1003 수정 제목',
        proposalReason: '의안 1003 최종 제안 이유',
      }),
    ]);

    await seedNotice1001(noticeStateByNum);
    await seedNotice1002(noticeStateByNum);
    await seedNotice1003(noticeStateByNum);
  }

  async function seedNotice1001(
    noticeStateByNum: Map<number, Record<string, unknown>>,
  ): Promise<void> {
    await appendEvent(
      {
        noticeNum: 1001,
        eventType: CHANGE_EVENT_TYPE.CREATED,
        source: LEGACY_GENESIS_SOURCE,
        detectedAt: '2026-07-01T00:00:00.000Z',
        details: [
          {
            fieldPath: 'subject',
            changeType: 'added',
            beforeValue: null,
            afterValue: '의안 1001 최초 제목',
          },
          {
            fieldPath: 'proposalReason',
            changeType: 'added',
            beforeValue: null,
            afterValue: '의안 1001 최초 제안 이유',
          },
        ],
      },
      noticeStateByNum,
    );
  }

  async function seedNotice1002(
    noticeStateByNum: Map<number, Record<string, unknown>>,
  ): Promise<void> {
    await appendEvent(
      {
        noticeNum: 1002,
        eventType: CHANGE_EVENT_TYPE.CREATED,
        source: LEGACY_GENESIS_SOURCE,
        detectedAt: '2026-07-01T00:00:00.000Z',
        details: [
          {
            fieldPath: 'subject',
            changeType: 'added',
            beforeValue: null,
            afterValue: '의안 1002 최초 제목',
          },
          {
            fieldPath: 'proposalReason',
            changeType: 'added',
            beforeValue: null,
            afterValue: '의안 1002 최초 제안 이유',
          },
        ],
      },
      noticeStateByNum,
    );

    await appendEvent(
      {
        noticeNum: 1002,
        eventType: CHANGE_EVENT_TYPE.UPDATED,
        source: NoticeChangeSource.ARCHIVE_UPSERT,
        detectedAt: '2026-07-02T00:00:00.000Z',
        details: [
          {
            fieldPath: 'subject',
            changeType: 'modified',
            beforeValue: '의안 1002 최초 제목',
            afterValue: '의안 1002 수정 제목',
          },
        ],
      },
      noticeStateByNum,
    );
  }

  async function seedNotice1003(
    noticeStateByNum: Map<number, Record<string, unknown>>,
  ): Promise<void> {
    await appendEvent(
      {
        noticeNum: 1003,
        eventType: CHANGE_EVENT_TYPE.CREATED,
        source: LEGACY_GENESIS_SOURCE,
        detectedAt: '2026-07-01T00:00:00.000Z',
        details: [
          {
            fieldPath: 'subject',
            changeType: 'added',
            beforeValue: null,
            afterValue: '의안 1003 최초 제목',
          },
          {
            fieldPath: 'proposalReason',
            changeType: 'added',
            beforeValue: null,
            afterValue: '의안 1003 최초 제안 이유',
          },
        ],
      },
      noticeStateByNum,
    );

    await appendEvent(
      {
        noticeNum: 1003,
        eventType: CHANGE_EVENT_TYPE.UPDATED,
        source: NoticeChangeSource.ARCHIVE_UPSERT,
        detectedAt: '2026-07-02T00:00:00.000Z',
        details: [
          {
            fieldPath: 'subject',
            changeType: 'modified',
            beforeValue: '의안 1003 최초 제목',
            afterValue: '의안 1003 수정 제목',
          },
        ],
      },
      noticeStateByNum,
    );

    await appendEvent(
      {
        noticeNum: 1003,
        eventType: CHANGE_EVENT_TYPE.UPDATED,
        source: NoticeChangeSource.ARCHIVE_UPDATE_SOURCE_HTML,
        detectedAt: '2026-07-03T00:00:00.000Z',
        details: [
          {
            fieldPath: 'proposalReason',
            changeType: 'modified',
            beforeValue: '의안 1003 최초 제안 이유',
            afterValue: '의안 1003 최종 제안 이유',
          },
        ],
      },
      noticeStateByNum,
    );
  }

  function createArchiveNotice(params: {
    noticeNum: number;
    subject: string;
    proposalReason: string;
  }): Partial<NoticeArchive> {
    return {
      noticeNum: params.noticeNum,
      subject: params.subject,
      proposerCategory: '의원',
      committee: '정무위원회',
      assemblyLink: `https://example.test/notices/${params.noticeNum}`,
      contentId: `content-${params.noticeNum}`,
      proposalReason: params.proposalReason,
      sourceTitle: params.subject,
      contentBillNumber: `BILL-${params.noticeNum}`,
      contentProposer: '테스트 의원',
      contentProposalDate: '2026-07-01',
      contentCommittee: '정무위원회',
      contentReferralDate: '2026-07-02',
      contentNoticePeriod: '2026-07-01 ~ 2026-07-10',
      contentProposalSession: '제22대',
      aiSummary: null,
      aiSummaryStatus: 'not_requested',
      attachmentPdfFile: '',
      attachmentHwpFile: '',
      archivedAt: new Date('2026-07-04T00:00:00.000Z'),
      sourceHtml: `<html><body>${params.subject}</body></html>`,
      sourceHtmlSha256: createHash('sha256')
        .update(`<html><body>${params.subject}</body></html>`)
        .digest('hex'),
      integrityVerifiedAt: new Date('2026-07-04T00:00:00.000Z'),
      integrityCheckPassed: true,
      httpMetadataJson: JSON.stringify({
        requestUrl: `https://example.test/request/${params.noticeNum}`,
        responseUrl: `https://example.test/response/${params.noticeNum}`,
      }),
      httpFetchedAt: new Date('2026-07-04T00:00:00.000Z'),
      httpStatusCode: 200,
      httpContentType: 'text/html',
      httpEtag: null,
      httpLastModified: null,
      isDone: false,
      lifecycleStatus: 'active',
      sourceDeletedAt: null,
      screenshotBlob: null,
      screenshotFormat: null,
    };
  }

  async function appendEvent(
    params: {
      noticeNum: number;
      eventType: ChangeEventType;
      source: NoticeChangeSource;
      detectedAt: string;
      details: SeedDetail[];
    },
    noticeStateByNum: Map<number, Record<string, unknown>> = new Map(),
  ): Promise<void> {
    const previousSnapshot =
      params.eventType === CHANGE_EVENT_TYPE.CREATED
        ? null
        : (noticeStateByNum.get(params.noticeNum) ?? null);

    const trackedFields = getTrackedFieldsForCanonVersion(2);
    const nextSnapshot = Object.fromEntries(
      trackedFields.map((fieldPath) => [fieldPath, null]),
    ) as Record<string, unknown>;

    if (previousSnapshot) {
      for (const fieldPath of trackedFields) {
        if (Object.prototype.hasOwnProperty.call(previousSnapshot, fieldPath)) {
          nextSnapshot[fieldPath] = previousSnapshot[fieldPath];
        }
      }
    }

    nextSnapshot.num = params.noticeNum;
    nextSnapshot.proposerCategory = '의원';
    nextSnapshot.committee = '정무위원회';
    nextSnapshot.isDone = false;
    nextSnapshot.lifecycleStatus = 'active';
    nextSnapshot.sourceDeletedAt = null;

    // Mirror the archive row fields that buildAuditSeedSnapshot reads,
    // so the audit's reconstructed state matches the write path.
    nextSnapshot.contentId = `content-${params.noticeNum}`;
    nextSnapshot.billNumber = `BILL-${params.noticeNum}`;
    nextSnapshot.proposer = '테스트 의원';
    nextSnapshot.proposalDate = '2026-07-01';
    nextSnapshot.contentCommittee = '정무위원회';
    nextSnapshot.referralDate = '2026-07-02';
    nextSnapshot.noticePeriod = '2026-07-01 ~ 2026-07-10';
    nextSnapshot.proposalSession = '제22대';

    for (const detail of params.details) {
      nextSnapshot[detail.fieldPath] =
        detail.afterValue === undefined ? null : detail.afterValue;
    }

    const built = changeTrackingService.buildDiffEvent({
      noticeNum: params.noticeNum,
      beforeSnapshot: previousSnapshot,
      afterSnapshot: nextSnapshot,
      detectedAt: new Date(params.detectedAt),
      source: params.source,
      canonVersion: 2,
    });

    await changeTrackingService.appendChangeEventWithDetails({
      noticeNum: params.noticeNum,
      eventType: params.eventType,
      source: params.source,
      detectedAt: new Date(params.detectedAt),
      eventHash: built.eventHash,
      changedFieldCount: built.diff.changedFieldCount,
      diffSummaryJson: built.diff.diffSummaryJson,
      canonVersion: 2,
      details: built.diff.details.map((detail) => ({
        fieldPath: detail.fieldPath,
        changeType: detail.changeType,
        beforeValue: detail.beforeValue,
        afterValue: detail.afterValue,
        beforeHash: detail.beforeHash,
        afterHash: detail.afterHash,
      })),
    });

    noticeStateByNum.set(params.noticeNum, nextSnapshot);
  }
});
