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
import { NotificationService } from '../modules/notification/notification.service';
import { HashguardService } from '../modules/shared/hashguard.service';
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
import { NoticeChangeSource } from '../modules/change-tracking/notice-change-source.enum';
import { NoticeArchive } from '../modules/notice/notice-archive.entity';
import { NoticeChangeEvent } from '../modules/change-tracking/notice-change-event.entity';
import {
  NoticeChangeDetail,
  type ChangeDetailType,
} from '../modules/change-tracking/notice-change-detail.entity';
import { DataSource, Repository } from 'typeorm';

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
          provide: NotificationService,
          useValue: {
            testWebhook: jest.fn(),
            sendDiscordNotificationBatch: jest.fn(),
          },
        },
        {
          provide: HashguardService,
          useValue: {
            verifyProof: jest.fn().mockResolvedValue(true),
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

    await seedNotice1001();
    await seedNotice1002();
    await seedNotice1003();
  }

  async function seedNotice1001(): Promise<void> {
    await appendEvent({
      noticeNum: 1001,
      eventType: 'created',
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
    });
  }

  async function seedNotice1002(): Promise<void> {
    await appendEvent({
      noticeNum: 1002,
      eventType: 'created',
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
    });

    await appendEvent({
      noticeNum: 1002,
      eventType: 'updated',
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
    });
  }

  async function seedNotice1003(): Promise<void> {
    await appendEvent({
      noticeNum: 1003,
      eventType: 'created',
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
    });

    await appendEvent({
      noticeNum: 1003,
      eventType: 'updated',
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
    });

    await appendEvent({
      noticeNum: 1003,
      eventType: 'updated',
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
    });
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

  async function appendEvent(params: {
    noticeNum: number;
    eventType: 'created' | 'updated';
    source: NoticeChangeSource;
    detectedAt: string;
    details: SeedDetail[];
  }): Promise<void> {
    await changeTrackingService.appendChangeEventWithDetails({
      noticeNum: params.noticeNum,
      eventType: params.eventType,
      source: params.source,
      detectedAt: new Date(params.detectedAt),
      eventHash: createHash('sha256')
        .update(
          `${params.noticeNum}:${params.eventType}:${params.source}:${params.detectedAt}:${params.details
            .map((detail) => `${detail.fieldPath}:${detail.afterValue ?? ''}`)
            .join('|')}`,
        )
        .digest('hex'),
      changedFieldCount: params.details.length,
      details: params.details,
    });
  }
});
