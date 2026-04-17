import { createHash } from 'crypto';
import { describe, expect, it, jest } from '@jest/globals';
import { NoticeArchiveService } from './notice-archive.service';
import { NoticeArchive } from '../entities/notice-archive.entity';

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
  });

  const buildRow = (overrides: Partial<NoticeArchive> = {}): NoticeArchive => {
    const sourceHtml = '<html><body>LawCast Integrity Test</body></html>';
    const sourceHtmlSha256 = createHash('sha256')
      .update(sourceHtml, 'utf8')
      .digest('hex');

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
      archiveStartedAt: new Date('2026-04-17T00:00:02.000Z'),
      lastUpdatedAt: new Date('2026-04-17T00:00:03.000Z'),
      ...overrides,
    };
  };

  it('includes bash and powershell verification scripts in archive export', async () => {
    const repositoryMock = createRepositoryMock();
    const service = new NoticeArchiveService(repositoryMock as any);
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
    expect(bashScript?.content).toContain('jq -rj ".dbRecord.sourceHtml"');
    expect(bashScript?.content).toContain('cut -d " " -f1');

    expect(powerShellScript?.content).toContain(
      `$JsonFile = "${result?.jsonFileName}"`,
    );
    expect(powerShellScript?.content).toContain(
      `$IntegrityFile = "${result?.integrityFileName}"`,
    );
    expect(powerShellScript?.content).toContain('ConvertFrom-Json');
    expect(powerShellScript?.content).toContain('SHA256');
  });

  it('builds a structurally consistent export payload and metadata files', async () => {
    const repositoryMock = createRepositoryMock();
    const service = new NoticeArchiveService(repositoryMock as any);
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
    const service = new NoticeArchiveService(repositoryMock as any);

    repositoryMock.findOne.mockResolvedValue(null);

    const result = await service.buildArchiveExportFile(1234567);

    expect(result).toBeNull();
  });
});
