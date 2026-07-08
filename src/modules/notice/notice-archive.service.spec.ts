import { describe, expect, it, jest } from '@jest/globals';
import { NoticeArchiveService } from './notice-archive.service';
import { NoticeArchive } from '../notice/notice-archive.entity';
import { computeSha256 } from './notice-archive.helpers';
import { computeDiff } from '../change-tracking/change-tracking-diff.utils';

describe('NoticeArchiveService', () => {
  const createRepositoryMock = () => ({
    findOne:
      jest.fn<
        (params: {
          where: { noticeNum: number };
        }) => Promise<NoticeArchive | null>
      >(),
    update: jest
      .fn<(criteria: { id: number }, partialEntity: unknown) => Promise<void>>()
      .mockResolvedValue(undefined),
    create: jest.fn<(entity: Partial<NoticeArchive>) => NoticeArchive>(
      (entity) => entity as NoticeArchive,
    ),
    save: jest
      .fn<(entity: NoticeArchive) => Promise<NoticeArchive>>()
      .mockImplementation(async (entity) => entity),
  });

  const createChangeTrackingServiceMock = () => ({
    beginChangeNotificationCollection: jest.fn<(...args: any[]) => void>(),
    endChangeNotificationCollection: jest
      .fn<(...args: any[]) => Promise<void>>()
      .mockResolvedValue(undefined),
    flushQueuedChangeNotificationsNow: jest
      .fn<(...args: any[]) => Promise<void>>()
      .mockResolvedValue(undefined),
    getNoticeChangeTimeline: jest
      .fn<(...args: any[]) => Promise<any[]>>()
      .mockResolvedValue([]),
    getLatestFieldAfterValue: jest
      .fn<(...args: any[]) => Promise<string | null>>()
      .mockResolvedValue(null),
    buildDiffEvent: jest.fn((input: any) => {
      const diff = computeDiff(input.beforeSnapshot, input.afterSnapshot);
      return {
        shouldAppend: input.beforeSnapshot === null || diff.changed,
        eventType: input.beforeSnapshot === null ? 'created' : 'updated',
        diff,
        eventHash: 'test-event-hash',
        detectedAt: new Date('2026-01-01T00:00:00.000Z'),
        hashAlgo: 'sha256',
        canonVersion: 1,
      };
    }),
    appendChangeEventWithDetails: jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({ id: 1 }),
    dispatchChangeNotification: jest
      .fn<(...args: any[]) => Promise<void>>()
      .mockResolvedValue(undefined),
  });

  const createSummaryStateRepositoryMock = () => ({
    find: jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue([]),
    findOne: jest.fn<(...args: any[]) => Promise<any>>(),
    update: jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue(undefined),
    insert: jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue(undefined),
    delete: jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue(undefined),
  });

  const buildRow = (overrides: Partial<NoticeArchive> = {}): NoticeArchive => {
    const sourceHtml = '<html><body>LawCast Integrity Test</body></html>';
    const sourceHtmlSha256 = computeSha256(sourceHtml);

    return {
      id: 1,
      noticeNum: 2219999,
      subject: '테스트 법률안',
      proposerCategory: '정부',
      committee: '정무위원회',
      assemblyLink: 'https://pal.assembly.go.kr',
      contentId: 'PRC_TEST',
      proposalReason: '테스트 제안이유',
      sourceTitle: '테스트 원문 제목',
      contentBillNumber: null,
      contentProposer: null,
      contentProposalDate: null,
      contentCommittee: null,
      contentReferralDate: null,
      contentNoticePeriod: null,
      contentProposalSession: null,
      aiSummary: null,
      aiSummaryStatus: 'not_requested',
      attachmentPdfFile: '',
      attachmentHwpFile: '',
      archivedAt: new Date('2026-04-17T00:00:00.000Z'),
      sourceHtml,
      sourceHtmlSha256,
      integrityVerifiedAt: null,
      integrityCheckPassed: null,
      httpMetadataJson: JSON.stringify({
        requestUrl: 'https://pal.assembly.go.kr/test',
      }),
      httpFetchedAt: new Date('2026-04-17T00:00:01.000Z'),
      httpStatusCode: 200,
      httpContentType: 'text/html; charset=utf-8',
      httpEtag: null,
      httpLastModified: null,
      isDone: false,
      lifecycleStatus: 'active',
      sourceDeletedAt: null,
      archiveStartedAt: new Date('2026-04-17T00:00:02.000Z'),
      screenshotBlob: null,
      screenshotFormat: null,
      ...overrides,
    };
  };

  it('includes bash and powershell verification scripts in archive export', async () => {
    const repositoryMock = createRepositoryMock();
    const changeTrackingService = createChangeTrackingServiceMock();
    const service = new NoticeArchiveService(
      repositoryMock as any,
      undefined as any,
      changeTrackingService as any,
    );
    const row = buildRow();

    repositoryMock.findOne.mockResolvedValue(row);

    const result = await service.buildArchiveExportFile(row.noticeNum);

    expect(result).not.toBeNull();
    expect(result?.verificationScripts).toHaveLength(2);

    const bashScript = result?.verificationScripts?.find(
      (script) => script.fileName === 'verify-integrity.sh',
    );
    const powerShellScript = result?.verificationScripts?.find(
      (script) => script.fileName === 'verify-integrity.ps1',
    );

    expect(bashScript).toBeDefined();
    expect(powerShellScript).toBeDefined();

    expect(bashScript?.content).toContain(
      `JSON_FILE="${result?.jsonFileName}"`,
    );
    expect(bashScript?.content).toContain(
      `INTEGRITY_FILE="${result?.integrityFileName}"`,
    );
    expect(bashScript?.content).toContain('node -e');
    expect(bashScript?.content).toContain(
      'integritySnapshot?.calculatedSha256',
    );

    expect(powerShellScript?.content).toContain(
      `$JsonFile = "${result?.jsonFileName}"`,
    );
    expect(powerShellScript?.content).toContain(
      `$IntegrityFile = "${result?.integrityFileName}"`,
    );
    expect(powerShellScript?.content).toContain('ConvertFrom-Json');
    expect(powerShellScript?.content).toContain(
      'integritySnapshot.calculatedSha256',
    );
  });

  it('builds a structurally consistent export payload and metadata files', async () => {
    const repositoryMock = createRepositoryMock();
    const changeTrackingService = createChangeTrackingServiceMock();
    const service = new NoticeArchiveService(
      repositoryMock as any,
      undefined as any,
      changeTrackingService as any,
    );
    const row = buildRow({ noticeNum: 2218363 });

    repositoryMock.findOne.mockResolvedValue(row);

    const result = await service.buildArchiveExportFile(row.noticeNum);

    expect(result).not.toBeNull();

    const exportResult = result!;
    expect(exportResult.zipFileName.endsWith('.zip')).toBe(true);
    expect(exportResult.jsonFileName.endsWith('.json')).toBe(true);
    expect(exportResult.integrityFileName.endsWith('.integrity.txt')).toBe(
      true,
    );

    const expectedBaseName = exportResult.zipFileName.replace(/\.zip$/, '');
    expect(exportResult.jsonFileName).toBe(`${expectedBaseName}.json`);
    expect(exportResult.integrityFileName).toBe(
      `${expectedBaseName}.integrity.txt`,
    );

    const parsedJson = JSON.parse(exportResult.jsonContent) as {
      exportMeta: {
        formatVersion: string;
        recordType: string;
        noticeNum: number;
      };
      dbRecord: {
        noticeNum: number;
        sourceHtml: string;
        sourceHtmlSha256: string;
      };
      integritySnapshot: {
        storedSha256: string;
        calculatedSha256: string;
        passed: boolean;
      };
      httpMetadata: {
        requestUrl?: string;
      };
    };

    expect(parsedJson.exportMeta.formatVersion).toBe('1.0');
    expect(parsedJson.exportMeta.recordType).toBe('lawcast_notice_archive');
    expect(parsedJson.exportMeta.noticeNum).toBe(row.noticeNum);
    expect(parsedJson.dbRecord.noticeNum).toBe(row.noticeNum);
    expect(parsedJson.dbRecord.sourceHtml).toBe(row.sourceHtml);
    expect(parsedJson.dbRecord.sourceHtmlSha256).toBe(row.sourceHtmlSha256);
    expect(parsedJson.integritySnapshot.storedSha256).toBe(
      row.sourceHtmlSha256,
    );
    expect(parsedJson.integritySnapshot.calculatedSha256).toBe(
      row.sourceHtmlSha256,
    );
    expect(parsedJson.integritySnapshot.passed).toBe(true);
    expect(parsedJson.httpMetadata.requestUrl).toBe(
      'https://pal.assembly.go.kr/test',
    );

    const expectedHtmlSize = Buffer.byteLength(row.sourceHtml!, 'utf8');
    expect(exportResult.integrityContent).toContain(
      `noticeNum: ${row.noticeNum}`,
    );
    expect(exportResult.integrityContent).toContain(
      `sourceHtmlSizeBytes: ${expectedHtmlSize}`,
    );
    expect(exportResult.integrityContent).toContain(
      `storedSha256: ${row.sourceHtmlSha256}`,
    );
    expect(exportResult.integrityContent).toContain(
      `calculatedSha256: ${row.sourceHtmlSha256}`,
    );
    expect(exportResult.integrityContent).toContain('integrityPassed: true');

    expect(exportResult.verificationScripts).toBeDefined();
    const scriptFileNames = (exportResult.verificationScripts || [])
      .map((script) => script.fileName)
      .sort();
    expect(scriptFileNames).toEqual([
      'verify-integrity.ps1',
      'verify-integrity.sh',
    ]);

    for (const script of exportResult.verificationScripts || []) {
      expect(script.content).toContain(exportResult.jsonFileName);
      expect(script.content).toContain(exportResult.integrityFileName);
    }
  });

  it('returns null when archive row is missing', async () => {
    const repositoryMock = createRepositoryMock();
    const changeTrackingService = createChangeTrackingServiceMock();
    const service = new NoticeArchiveService(
      repositoryMock as any,
      undefined as any,
      changeTrackingService as any,
    );

    repositoryMock.findOne.mockResolvedValue(null);

    const result = await service.buildArchiveExportFile(1234567);

    expect(result).toBeNull();
  });

  describe('getPendingSummaryPage', () => {
    it('queries only not_requested rows and maps fields to CachedNotice shape', async () => {
      const pendingRows: NoticeArchive[] = [
        buildRow({
          noticeNum: 1001,
          subject: '백필 테스트 법률안',
          proposerCategory: '정부',
          committee: '국방위원회',
          assemblyLink: 'https://example.com/1001',
          contentId: 'PRC_BACKFILL_1',
          attachmentPdfFile: 'test.pdf',
          attachmentHwpFile: 'test.hwp',
          aiSummaryStatus: 'not_requested',
          aiSummary: null,
        }),
      ];

      const findMock = jest
        .fn<(options: Record<string, unknown>) => Promise<NoticeArchive[]>>()
        .mockResolvedValue(pendingRows);
      const repoMock = { ...createRepositoryMock(), find: findMock };
      const changeTrackingService = createChangeTrackingServiceMock();
      const service = new NoticeArchiveService(
        repoMock as any,
        undefined as any,
        changeTrackingService as any,
      );

      const result = await service.getPendingSummaryPage(50);

      expect(findMock).toHaveBeenCalledTimes(1);
      const callArg = findMock.mock.calls[0][0] as Record<string, unknown>;
      expect(
        (callArg['where'] as Record<string, unknown>)['aiSummaryStatus'],
      ).toBe('not_requested');
      expect(callArg['take']).toBe(50);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        num: 1001,
        subject: '백필 테스트 법률안',
        proposerCategory: '정부',
        committee: '국방위원회',
        link: 'https://example.com/1001',
        contentId: 'PRC_BACKFILL_1',
        attachments: { pdfFile: 'test.pdf', hwpFile: 'test.hwp' },
        aiSummary: null,
        aiSummaryStatus: 'not_requested',
      });
    });

    it('returns an empty array when no pending rows exist', async () => {
      const findMock = jest
        .fn<(options: Record<string, unknown>) => Promise<NoticeArchive[]>>()
        .mockResolvedValue([]);
      const repoMock = { ...createRepositoryMock(), find: findMock };
      const changeTrackingService = createChangeTrackingServiceMock();
      const service = new NoticeArchiveService(
        repoMock as any,
        undefined as any,
        changeTrackingService as any,
      );

      const result = await service.getPendingSummaryPage(50);

      expect(result).toEqual([]);
    });
  });

  describe('getUnavailableSummaryPage', () => {
    it('queries only unavailable rows, applies skip/take, and maps fields to CachedNotice shape', async () => {
      const unavailableRows: NoticeArchive[] = [
        buildRow({
          noticeNum: 2002,
          subject: '재시도 테스트 법률안',
          proposerCategory: '의원',
          committee: '법사위',
          assemblyLink: 'https://example.com/2002',
          contentId: 'PRC_RETRY_2',
          attachmentPdfFile: 'retry.pdf',
          attachmentHwpFile: 'retry.hwp',
          aiSummaryStatus: 'unavailable',
          aiSummary: null,
        }),
      ];

      const findMock = jest
        .fn<(options: Record<string, unknown>) => Promise<NoticeArchive[]>>()
        .mockResolvedValue(unavailableRows);
      const repoMock = { ...createRepositoryMock(), find: findMock };
      const changeTrackingService = createChangeTrackingServiceMock();
      const service = new NoticeArchiveService(
        repoMock as any,
        undefined as any,
        changeTrackingService as any,
      );

      const result = await service.getUnavailableSummaryPage(50, 25);

      expect(findMock).toHaveBeenCalledTimes(1);
      const callArg = findMock.mock.calls[0][0] as Record<string, unknown>;
      expect(
        (callArg['where'] as Record<string, unknown>)['aiSummaryStatus'],
      ).toBe('unavailable');
      expect(callArg['skip']).toBe(50);
      expect(callArg['take']).toBe(25);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        num: 2002,
        subject: '재시도 테스트 법률안',
        proposerCategory: '의원',
        committee: '법사위',
        link: 'https://example.com/2002',
        contentId: 'PRC_RETRY_2',
        attachments: { pdfFile: 'retry.pdf', hwpFile: 'retry.hwp' },
        aiSummary: null,
        aiSummaryStatus: 'unavailable',
      });
    });

    it('returns an empty array when no unavailable rows exist', async () => {
      const findMock = jest
        .fn<(options: Record<string, unknown>) => Promise<NoticeArchive[]>>()
        .mockResolvedValue([]);
      const repoMock = { ...createRepositoryMock(), find: findMock };
      const changeTrackingService = createChangeTrackingServiceMock();
      const service = new NoticeArchiveService(
        repoMock as any,
        undefined as any,
        changeTrackingService as any,
      );

      const result = await service.getUnavailableSummaryPage(0, 50);

      expect(result).toEqual([]);
    });
  });

  describe('change notification collection bridge', () => {
    it('forwards begin/end/flush calls to ChangeTrackingService when available', async () => {
      const repositoryMock = createRepositoryMock();
      const changeTrackingService = createChangeTrackingServiceMock();

      const service = new NoticeArchiveService(
        repositoryMock as any,
        undefined as any,
        changeTrackingService as any,
      );

      service.beginChangeNotificationCollection();
      await service.endChangeNotificationCollection();
      await service.flushQueuedChangeNotifications();

      expect(
        changeTrackingService.beginChangeNotificationCollection,
      ).toHaveBeenCalledTimes(1);
      expect(
        changeTrackingService.endChangeNotificationCollection,
      ).toHaveBeenCalledTimes(1);
      expect(
        changeTrackingService.flushQueuedChangeNotificationsNow,
      ).toHaveBeenCalledTimes(1);
    });

    it('throws when ChangeTrackingService is missing in immutable diffchain mode', async () => {
      const repositoryMock = createRepositoryMock();
      expect(() => new NoticeArchiveService(repositoryMock as any)).toThrow(
        'ChangeTrackingService is required for immutable diffchain mode.',
      );
    });
  });

  describe('proposalReason no-op protections', () => {
    it('does not append an event when proposalReason differs only by whitespace normalization', async () => {
      const repositoryMock = {
        ...createRepositoryMock(),
      };
      const changeTrackingService = createChangeTrackingServiceMock();
      changeTrackingService.getLatestFieldAfterValue.mockResolvedValue(
        '사유   본문',
      );

      repositoryMock.findOne.mockResolvedValue(
        buildRow({
          noticeNum: 2219775,
          subject: '테스트 법률안',
          proposalReason: '',
          contentId: null,
          contentBillNumber: '2219775',
        }),
      );

      const service = new NoticeArchiveService(
        repositoryMock as any,
        undefined as any,
        changeTrackingService as any,
      );

      await service.updateNsmHtmlAndDetail(2219775, {
        html: '',
        sha256: '',
        proposalReason: ' 사유 본문 ',
        httpMetadata: null,
      });

      expect(
        changeTrackingService.appendChangeEventWithDetails,
      ).not.toHaveBeenCalled();
      expect(
        changeTrackingService.dispatchChangeNotification,
      ).not.toHaveBeenCalled();
    });

    it('includes NOT EXISTS guard in retry-candidate query to skip already-resolved chain rows', async () => {
      const qb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockImplementation(async () => [
          {
            noticeNum: 2219775,
            subject: '테스트 법률안',
            proposerCategory: '의원',
            committee: '법사위',
            assemblyLink: 'https://example.com/nsm/2219775',
            contentBillNumber: '2219775',
            attachmentPdfFile: '',
            attachmentHwpFile: '',
          },
        ]),
      };

      const repositoryMock = {
        ...createRepositoryMock(),
        createQueryBuilder: jest.fn().mockReturnValue(qb),
      };
      const changeTrackingService = createChangeTrackingServiceMock();
      const service = new NoticeArchiveService(
        repositoryMock as any,
        undefined as any,
        changeTrackingService as any,
      );

      const result = await service.getNsmProposalReasonRetryCandidates(10);

      expect(repositoryMock.createQueryBuilder).toHaveBeenCalledWith('na');
      const notExistsCall = (qb.andWhere as jest.Mock).mock.calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          (call[0] as string).includes('NOT EXISTS'),
      );
      expect(notExistsCall).toBeDefined();
      expect(notExistsCall?.[1]).toEqual({
        proposalReasonFieldPath: 'proposalReason',
      });

      const lifecycleNotExistsCall = (qb.andWhere as jest.Mock).mock.calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          (call[0] as string).includes('lifecycleStatusFieldPath'),
      );
      expect(lifecycleNotExistsCall).toBeDefined();
      expect(lifecycleNotExistsCall?.[1]).toEqual({
        lifecycleStatusFieldPath: 'lifecycleStatus',
        sourceDeletedLifecycle: 'source_deleted',
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        billNo: '2219775',
        notice: {
          num: 2219775,
          subject: '테스트 법률안',
          aiSummaryStatus: 'not_supported',
        },
      });
    });
  });

  describe('upsert diff false-removal protections', () => {
    it('does not emit removed changes when content fetch fails and existing tracked values are still valid', async () => {
      const repositoryMock = {
        ...createRepositoryMock(),
      };
      const changeTrackingService = createChangeTrackingServiceMock();

      repositoryMock.findOne.mockResolvedValue(
        buildRow({
          noticeNum: 2219801,
          subject: '기존 법률안',
          proposerCategory: '정부',
          committee: '정무위원회',
          proposalReason: '기존 제안이유',
          contentBillNumber: '220001',
          contentProposer: '홍길동',
          contentProposalDate: '2026-01-01',
          contentCommittee: '정무위원회',
          contentReferralDate: '2026-01-02',
          contentNoticePeriod: '2026-01-03~2026-02-02',
          contentProposalSession: '제420회',
          isDone: true,
        }),
      );

      const service = new NoticeArchiveService(
        repositoryMock as any,
        undefined as any,
        changeTrackingService as any,
      );

      await service.upsertNoticeArchive(
        {
          num: 2219801,
          subject: '기존 법률안',
          proposerCategory: '정부',
          committee: '정무위원회',
          link: 'https://example.com/2219801',
          contentId: 'PRC_2219801',
          attachments: { pdfFile: '', hwpFile: '' },
        },
        {
          // fetch 실패 상황과 동일하게 빈값/누락 전달
          proposalReason: '',
          billNumber: undefined,
          proposer: undefined,
          proposalDate: undefined,
          committee: undefined,
          referralDate: undefined,
          noticePeriod: undefined,
          proposalSession: undefined,
          isDone: undefined,
          sourceHtml: null,
          htmlSha256: null,
          httpMetadata: null,
        },
      );

      expect(
        changeTrackingService.appendChangeEventWithDetails,
      ).not.toHaveBeenCalled();
      expect(repositoryMock.save).not.toHaveBeenCalled();
    });

    it('uses chain-head baseline to avoid stale-row re-emission', async () => {
      const repositoryMock = {
        ...createRepositoryMock(),
      };
      const changeTrackingService = createChangeTrackingServiceMock();

      repositoryMock.findOne.mockResolvedValue(
        buildRow({
          noticeNum: 2219802,
          proposalReason: 'stale row value',
          contentId: 'PRC_2219802',
        }),
      );

      changeTrackingService.getNoticeChangeTimeline.mockResolvedValue([
        {
          eventHeight: 1,
          details: [
            {
              fieldPath: 'proposalReason',
              afterValue: 'chain head value',
            },
          ],
        },
      ]);

      const service = new NoticeArchiveService(
        repositoryMock as any,
        undefined as any,
        changeTrackingService as any,
      );

      await service.upsertNoticeArchive(
        {
          num: 2219802,
          subject: '테스트 법률안',
          proposerCategory: '정부',
          committee: '정무위원회',
          link: 'https://example.com/2219802',
          contentId: 'PRC_2219802',
          attachments: { pdfFile: '', hwpFile: '' },
        },
        {
          proposalReason: 'chain head value',
          sourceHtml: null,
          htmlSha256: null,
          httpMetadata: null,
        },
      );

      expect(
        changeTrackingService.appendChangeEventWithDetails,
      ).not.toHaveBeenCalled();
    });

    it('restores a previously removed field when a later crawl provides the value again', async () => {
      const repositoryMock = {
        ...createRepositoryMock(),
      };
      const changeTrackingService = createChangeTrackingServiceMock();

      repositoryMock.findOne.mockResolvedValue(
        buildRow({
          noticeNum: 2219803,
          subject: '복구 테스트 법률안',
          proposalReason: 'legacy db value',
          contentId: 'PRC_2219803',
        }),
      );

      // 체인 헤드가 이미 removed 상태(null)로 오염된 상황을 가정
      changeTrackingService.getNoticeChangeTimeline.mockResolvedValue([
        {
          eventHeight: 1,
          details: [
            {
              fieldPath: 'proposalReason',
              afterValue: null,
            },
          ],
        },
      ]);

      const service = new NoticeArchiveService(
        repositoryMock as any,
        undefined as any,
        changeTrackingService as any,
      );

      await service.upsertNoticeArchive(
        {
          num: 2219803,
          subject: '복구 테스트 법률안',
          proposerCategory: '정부',
          committee: '정무위원회',
          link: 'https://example.com/2219803',
          contentId: 'PRC_2219803',
          attachments: { pdfFile: '', hwpFile: '' },
        },
        {
          proposalReason: '정상 제안이유 복구값',
          sourceHtml: null,
          htmlSha256: null,
          httpMetadata: null,
        },
      );

      expect(
        changeTrackingService.appendChangeEventWithDetails,
      ).toHaveBeenCalledTimes(1);

      const callArg = (
        changeTrackingService.appendChangeEventWithDetails as jest.Mock
      ).mock.calls[0][0] as {
        details: Array<{
          fieldPath: string;
          changeType: string;
          beforeValue: string | null;
          afterValue: string | null;
        }>;
      };

      const proposalReasonDetail = callArg.details.find(
        (detail) => detail.fieldPath === 'proposalReason',
      );

      expect(proposalReasonDetail).toBeDefined();
      expect(proposalReasonDetail?.changeType).toBe('added');
      expect(proposalReasonDetail?.beforeValue).toBeNull();
      expect(proposalReasonDetail?.afterValue).toBe('정상 제안이유 복구값');
    });
  });

  describe('invalidated isDone promotion', () => {
    it('promotes source_deleted invalidation to isDone=true in summary state', async () => {
      const repositoryMock = createRepositoryMock();
      const summaryStateRepositoryMock = createSummaryStateRepositoryMock();
      const changeTrackingService = createChangeTrackingServiceMock();
      const service = new NoticeArchiveService(
        repositoryMock as any,
        summaryStateRepositoryMock as any,
        changeTrackingService as any,
      );

      repositoryMock.findOne.mockResolvedValue(
        buildRow({
          noticeNum: 2219901,
          subject: '삭제 감지 테스트 법률안',
          isDone: false,
          lifecycleStatus: 'active',
          sourceDeletedAt: null,
        }),
      );
      summaryStateRepositoryMock.find.mockResolvedValue([
        { noticeNum: 2219901, isDone: false },
      ]);
      summaryStateRepositoryMock.findOne
        .mockResolvedValueOnce({
          isDone: false,
          aiSummary: '기존 요약',
          aiSummaryStatus: 'ready',
        })
        .mockResolvedValueOnce({ id: 7 });

      await service.appendSourceDeletedEventByNoticeNum(2219901);

      expect(
        changeTrackingService.appendChangeEventWithDetails,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          noticeNum: 2219901,
          eventType: 'invalidated',
        }),
      );
      expect(summaryStateRepositoryMock.update).toHaveBeenCalledWith(
        { id: 7 },
        expect.objectContaining({
          isDone: true,
          aiSummary: '기존 요약',
          aiSummaryStatus: 'ready',
        }),
      );
    });

    it('creates default done summary state when source_deleted invalidation has no summary row', async () => {
      const repositoryMock = createRepositoryMock();
      const summaryStateRepositoryMock = createSummaryStateRepositoryMock();
      const changeTrackingService = createChangeTrackingServiceMock();
      const service = new NoticeArchiveService(
        repositoryMock as any,
        summaryStateRepositoryMock as any,
        changeTrackingService as any,
      );

      repositoryMock.findOne.mockResolvedValue(
        buildRow({
          noticeNum: 2219902,
          subject: '삭제 감지 기본 상태 테스트',
          isDone: false,
          lifecycleStatus: 'active',
        }),
      );
      summaryStateRepositoryMock.find.mockResolvedValue([
        { noticeNum: 2219902, isDone: false },
      ]);
      summaryStateRepositoryMock.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      await service.appendSourceDeletedEventByNoticeNum(2219902);

      expect(summaryStateRepositoryMock.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          noticeNum: 2219902,
          isDone: true,
          aiSummary: null,
          aiSummaryStatus: 'not_requested',
        }),
      );
    });
  });
});
