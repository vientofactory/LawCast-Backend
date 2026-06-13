import { MoreThan, type Repository } from 'typeorm';
import JSZip from 'jszip';
import { NoticeArchive } from '../notice-archive.entity';
import { buildArchiveExportArtifacts } from '../archive-export.builder';
import {
  computeSha256,
  mapArchiveEntityToNoticeItem,
  mapArchiveEntityToRawRecord,
  parseHttpMetadata,
} from '../notice-archive.helpers';
import type {
  ArchiveDetailResult,
  ArchiveExportResult,
} from '../notice-archive.service';

export class NoticeArchiveArtifactSupport {
  constructor(private readonly archiveRepository: Repository<NoticeArchive>) {}

  async getArchivedNoticeDetail(
    noticeNum: number,
  ): Promise<ArchiveDetailResult | null> {
    const row = await this.archiveRepository.findOne({
      where: { noticeNum },
    });

    if (!row) {
      return null;
    }

    const integrity = await this.verifyAndRefreshIntegrity(row);
    const httpMetadata = parseHttpMetadata(row.httpMetadataJson);

    return {
      notice: mapArchiveEntityToNoticeItem(row),
      originalContent: {
        contentId: row.contentId ?? '',
        title: row.sourceTitle?.trim() || row.subject,
        proposalReason: row.proposalReason || '',
        billNumber: row.contentBillNumber ?? null,
        proposer: row.contentProposer ?? null,
        proposalDate: row.contentProposalDate ?? null,
        committee: row.contentCommittee ?? null,
        referralDate: row.contentReferralDate ?? null,
        noticePeriod: row.contentNoticePeriod ?? null,
        proposalSession: row.contentProposalSession ?? null,
      },
      archiveMetadata: {
        archivedAt: row.archivedAt,
        sourceHtmlSha256: row.sourceHtmlSha256,
        sourceHtmlSize: row.sourceHtml
          ? Buffer.byteLength(row.sourceHtml, 'utf8')
          : 0,
        integrity: {
          checkedAt: integrity.checkedAt,
          passed: integrity.passed,
          calculatedSha256: integrity.calculatedSha256,
        },
        http: {
          fetchedAt: row.httpFetchedAt,
          statusCode: row.httpStatusCode,
          contentType: row.httpContentType,
          etag: row.httpEtag,
          lastModified: row.httpLastModified,
          requestUrl:
            typeof httpMetadata.requestUrl === 'string'
              ? httpMetadata.requestUrl
              : undefined,
          responseUrl:
            typeof httpMetadata.responseUrl === 'string'
              ? httpMetadata.responseUrl
              : undefined,
        },
      },
      screenshotMeta: {
        hasScreenshot: row.screenshotBlob != null,
        format: row.screenshotFormat ?? null,
      },
    };
  }

  async buildArchiveExportFile(
    noticeNum: number,
  ): Promise<ArchiveExportResult | null> {
    const row = await this.archiveRepository.findOne({
      where: { noticeNum },
    });

    if (!row) {
      return null;
    }

    const integrity = await this.verifyAndRefreshIntegrity(row);
    const httpMetadata = parseHttpMetadata(row.httpMetadataJson);
    const generatedAt = new Date();

    return buildArchiveExportArtifacts({
      noticeNum,
      generatedAt,
      row,
      integrity,
      httpMetadata,
      dbRecord: mapArchiveEntityToRawRecord(row),
    });
  }

  async buildArchiveExportZip(
    noticeNum: number,
  ): Promise<{ zipFileName: string; zipBuffer: Buffer } | null> {
    const [artifacts, screenshot] = await Promise.all([
      this.buildArchiveExportFile(noticeNum),
      this.getScreenshotByNoticeNum(noticeNum),
    ]);

    if (!artifacts) {
      return null;
    }

    const zip = new JSZip();
    zip.file(artifacts.jsonFileName, artifacts.jsonContent);
    zip.file(artifacts.integrityFileName, artifacts.integrityContent);

    for (const script of artifacts.verificationScripts) {
      zip.file(script.fileName, script.content);
    }

    if (screenshot) {
      zip.file(`screenshot.${screenshot.format}`, screenshot.blob);
    }

    return {
      zipFileName: artifacts.zipFileName,
      zipBuffer: await zip.generateAsync({ type: 'nodebuffer' }),
    };
  }

  async runIntegrityScan(
    batchSize = 200,
    forceUpdate = false,
  ): Promise<{
    scanned: number;
    passed: number;
    failed: number;
    skipped: number;
  }> {
    let lastSeenId = 0;
    let scanned = 0;
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    for (;;) {
      const rows = await this.archiveRepository.find({
        where: lastSeenId > 0 ? { id: MoreThan(lastSeenId) } : undefined,
        select: {
          id: true,
          sourceHtml: true,
          sourceHtmlSha256: true,
          integrityCheckPassed: true,
          integrityVerifiedAt: true,
        },
        order: { id: 'ASC' },
        take: batchSize,
      });

      if (rows.length === 0) break;

      const checkedAt = new Date();
      const updates: Array<{
        id: number;
        integrityCheckPassed: boolean;
        integrityVerifiedAt: Date;
      }> = [];

      for (const row of rows) {
        scanned++;
        if (!row.sourceHtml || !row.sourceHtmlSha256) {
          skipped++;
          continue;
        }
        const computed = computeSha256(row.sourceHtml);
        const ok = computed === row.sourceHtmlSha256;
        if (ok) passed++;
        else failed++;

        const resultChanged = row.integrityCheckPassed !== ok;
        const neverChecked = !row.integrityVerifiedAt;
        if (forceUpdate || resultChanged || neverChecked) {
          updates.push({
            id: row.id,
            integrityCheckPassed: ok,
            integrityVerifiedAt: checkedAt,
          });
        }
      }

      if (updates.length > 0) {
        await Promise.all(
          updates.map((update) =>
            this.archiveRepository.update(
              { id: update.id },
              {
                integrityCheckPassed: update.integrityCheckPassed,
                integrityVerifiedAt: update.integrityVerifiedAt,
              },
            ),
          ),
        );
      }

      lastSeenId = rows[rows.length - 1].id;
      if (rows.length < batchSize) break;
    }

    return { scanned, passed, failed, skipped };
  }

  private async getScreenshotByNoticeNum(
    noticeNum: number,
  ): Promise<{ blob: Buffer; format: string } | null> {
    const row = await this.archiveRepository.findOne({
      where: { noticeNum },
      select: { screenshotBlob: true, screenshotFormat: true },
    });

    if (!row?.screenshotBlob) {
      return null;
    }

    return {
      blob: row.screenshotBlob,
      format: row.screenshotFormat ?? 'jpeg',
    };
  }

  private async verifyAndRefreshIntegrity(row: NoticeArchive): Promise<{
    checkedAt: Date | null;
    passed: boolean | null;
    calculatedSha256: string | null;
  }> {
    if (!row.sourceHtml || !row.sourceHtmlSha256) {
      return {
        checkedAt: row.integrityVerifiedAt ?? null,
        passed: row.integrityCheckPassed ?? null,
        calculatedSha256: null,
      };
    }

    const calculatedSha256 = computeSha256(row.sourceHtml);
    const passed = calculatedSha256 === row.sourceHtmlSha256;
    const checkedAt = new Date();

    if (row.integrityCheckPassed !== passed || !row.integrityVerifiedAt) {
      await this.archiveRepository.update(
        { id: row.id },
        {
          integrityCheckPassed: passed,
          integrityVerifiedAt: checkedAt,
        },
      );

      row.integrityCheckPassed = passed;
      row.integrityVerifiedAt = checkedAt;
    }

    return {
      checkedAt: row.integrityVerifiedAt,
      passed,
      calculatedSha256,
    };
  }
}
