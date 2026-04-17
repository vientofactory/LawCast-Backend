import { Readable } from 'stream';
import { StreamableFile } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import JSZip from 'jszip';
import { ApiController } from './api.controller';
import { WebhookService } from '../services/webhook.service';
import { CrawlingService } from '../services/crawling.service';
import { NotificationService } from '../services/notification.service';
import { HashguardService } from '../services/hashguard.service';
import { BatchProcessingService } from '../services/batch-processing.service';
import { NoticeArchiveService } from '../services/notice-archive.service';
import { NoticesQueryService } from '../services/notices-query.service';

describe('ApiController archive export', () => {
  let controller: ApiController;
  let noticeArchiveService: {
    buildArchiveExportFile: jest.Mock;
  };

  const readAll = async (stream: Readable): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  };

  beforeEach(async () => {
    noticeArchiveService = {
      buildArchiveExportFile: jest.fn(),
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
          provide: NotificationService,
          useValue: {
            testWebhook: jest.fn(),
            sendDiscordNotificationBatch: jest.fn(),
          },
        },
        {
          provide: HashguardService,
          useValue: {
            verifyProof: jest.fn(),
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
          useValue: noticeArchiveService,
        },
        {
          provide: NoticesQueryService,
          useValue: {
            getArchivedNotices: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<ApiController>(ApiController);
  });

  it('builds ZIP with json, integrity metadata, and verification scripts', async () => {
    noticeArchiveService.buildArchiveExportFile.mockResolvedValue({
      zipFileName: 'lawcast-archive-2218363-2026-04-17T10-00-00-000Z.zip',
      jsonFileName: 'lawcast-archive-2218363-2026-04-17T10-00-00-000Z.json',
      jsonContent: '{"ok":true}',
      integrityFileName:
        'lawcast-archive-2218363-2026-04-17T10-00-00-000Z.integrity.txt',
      integrityContent: 'storedSha256: deadbeef',
      verificationScripts: [
        {
          fileName: 'verify-integrity.sh',
          content: '#!/usr/bin/env bash\necho ok\n',
        },
        {
          fileName: 'verify-integrity.ps1',
          content: 'Write-Host ok\n',
        },
      ],
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

    const stream = (result as StreamableFile).getStream() as Readable;
    const zipBuffer = await readAll(stream);
    const zip = await JSZip.loadAsync(zipBuffer);

    const fileNames = Object.keys(zip.files)
      .filter((name) => !zip.files[name].dir)
      .sort();

    expect(fileNames).toEqual([
      'lawcast-archive-2218363-2026-04-17T10-00-00-000Z.integrity.txt',
      'lawcast-archive-2218363-2026-04-17T10-00-00-000Z.json',
      'verify-integrity.ps1',
      'verify-integrity.sh',
    ]);

    const jsonText = await zip
      .file('lawcast-archive-2218363-2026-04-17T10-00-00-000Z.json')!
      .async('string');
    const integrityText = await zip
      .file('lawcast-archive-2218363-2026-04-17T10-00-00-000Z.integrity.txt')!
      .async('string');
    const bashText = await zip.file('verify-integrity.sh')!.async('string');
    const psText = await zip.file('verify-integrity.ps1')!.async('string');

    expect(jsonText).toBe('{"ok":true}');
    expect(integrityText).toContain('storedSha256: deadbeef');
    expect(bashText).toContain('#!/usr/bin/env bash');
    expect(psText).toContain('Write-Host ok');

    expect(setHeader).toHaveBeenCalledWith('Content-Type', 'application/zip');
    expect(setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="lawcast-archive-2218363-2026-04-17T10-00-00-000Z.zip"',
    );
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
});
