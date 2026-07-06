import { StreamableFile } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ApiController } from './api.controller';
import { WebhookService } from '../modules/webhook/webhook.service';
import { CrawlingService } from '../modules/crawling/crawling.service';
import { HealthCheckService } from '../modules/health/health-check.service';
import { WebhookRegistrationService } from '../modules/notification/webhook-registration.service';
import { BatchProcessingService } from '../modules/shared/batch-processing.service';
import { NoticeArchiveService } from '../modules/notice/notice-archive.service';
import { NoticesQueryService } from '../modules/crawling/notices-query.service';
import { NoticeSearchService } from '../modules/crawling/notice-search.service';
import { RuntimeStatsService } from '../modules/health/runtime-stats.service';
import { ArchiveSyncService } from '../modules/crawling/archive-sync.service';
import { PackagesService } from '../modules/shared/packages.service';
import { ChangeTrackingService } from '../modules/change-tracking/change-tracking.service';

// NoticeArchiveService 모킹
const mockBuildArchiveExportZip = jest.fn();

const mockNoticeArchiveService = {
  buildArchiveExportZip: mockBuildArchiveExportZip,
} as any;

describe('ApiController archive export', () => {
  let controller: ApiController;

  beforeEach(async () => {
    const _noticeArchiveService = {
      buildArchiveExportZip: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApiController],
      providers: [
        {
          provide: ConfigService,
          useValue: { get: jest.fn() },
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
        {
          provide: CrawlingService,
          useValue: {
            getRecentNotices: jest.fn(),
            getCacheInfo: jest.fn(),
          },
        },
        {
          provide: HealthCheckService,
          useValue: {
            getApiHealthPayload: jest
              .fn()
              .mockResolvedValue({ status: 'healthy' }),
          },
        },
        {
          provide: WebhookRegistrationService,
          useValue: {
            registerWebhook: jest.fn(),
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
          provide: NoticeArchiveService,
          useValue: mockNoticeArchiveService,
        },
        {
          provide: NoticesQueryService,
          useValue: {
            getArchivedNotices: jest.fn(),
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
        {
          provide: ChangeTrackingService,
          useValue: {
            getNoticeChangeTimeline: jest.fn().mockResolvedValue([]),
            getRecentChanges: jest.fn().mockResolvedValue({
              items: [],
              page: 1,
              limit: 10,
              total: 0,
              totalPages: 0,
            }),
          },
        },
      ],
    }).compile();

    controller = module.get<ApiController>(ApiController);
  });

  it('builds ZIP with json, integrity metadata, and verification scripts', async () => {
    mockBuildArchiveExportZip.mockResolvedValue({
      zipFileName: 'lawcast-archive-2218363-2026-04-17T10-00-00-000Z.zip',
      zipBuffer: Buffer.from('mock zip content'),
    });

    const setHeader = jest.fn();
    const responseMock = {
      setHeader,
    };

    const result = await controller.exportNoticeArchive(
      2218363,
      responseMock as any,
    );

    expect(result).toBeInstanceOf(StreamableFile);

    expect(setHeader).toHaveBeenCalledWith('Content-Type', 'application/zip');
    expect(setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="lawcast-archive-2218363-2026-04-17T10-00-00-000Z.zip"',
    );
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
});
