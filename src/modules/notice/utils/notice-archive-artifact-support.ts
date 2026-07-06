import { MoreThan, type Repository } from 'typeorm';
import JSZip from 'jszip';
import { NoticeArchive } from '../notice-archive.entity';
import { NoticeArchiveSummaryState } from '../notice-archive-summary-state.entity';
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
  constructor(
    private readonly archiveRepository: Repository<NoticeArchive>,
    private readonly summaryStateRepository?: Repository<NoticeArchiveSummaryState>,
  ) {}

  private async hydrateSummaryState(row: NoticeArchive): Promise<void> {
    if (!this.summaryStateRepository) {
      return;
    }

    const summaryState = await this.summaryStateRepository.findOne({
      where: { noticeNum: row.noticeNum },
      select: {
        aiSummary: true,
        aiSummaryStatus: true,
      },
    });

    if (!summaryState) {
      return;
    }

    row.aiSummary = summaryState.aiSummary;
    row.aiSummaryStatus = summaryState.aiSummaryStatus;
  }

  async getArchivedNoticeDetail(
    noticeNum: number,
  ): Promise<ArchiveDetailResult | null> {
    const row = await this.archiveRepository.findOne({
      where: { noticeNum },
    });

    if (!row) {
      return null;
    }

    await this.hydrateSummaryState(row);

    const integrity = await this.verifyAndRefreshIntegrity(row);
    const httpMetadata = parseHttpMetadata(row.httpMetadataJson);
    const fallbackFromHtml = this.extractPalFieldsFromSourceHtml(
      row.sourceHtml,
    );

    return {
      notice: mapArchiveEntityToNoticeItem(row),
      originalContent: {
        contentId: row.contentId ?? '',
        title: row.sourceTitle?.trim() || row.subject,
        proposalReason: row.proposalReason || '',
        billNumber: row.contentBillNumber ?? fallbackFromHtml.billNumber,
        proposer: row.contentProposer ?? fallbackFromHtml.proposer,
        proposalDate: row.contentProposalDate ?? fallbackFromHtml.proposalDate,
        committee: row.contentCommittee ?? fallbackFromHtml.committee,
        referralDate: row.contentReferralDate ?? fallbackFromHtml.referralDate,
        noticePeriod: row.contentNoticePeriod ?? fallbackFromHtml.noticePeriod,
        proposalSession:
          row.contentProposalSession ?? fallbackFromHtml.proposalSession,
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

  private extractPalFieldsFromSourceHtml(sourceHtml: string | null): {
    billNumber: string | null;
    proposer: string | null;
    proposalDate: string | null;
    committee: string | null;
    referralDate: string | null;
    noticePeriod: string | null;
    proposalSession: string | null;
  } {
    const empty = {
      billNumber: null,
      proposer: null,
      proposalDate: null,
      committee: null,
      referralDate: null,
      noticePeriod: null,
      proposalSession: null,
    };

    if (!sourceHtml || sourceHtml.trim().length === 0) {
      return empty;
    }

    const normalize = (value: string | null): string | null => {
      if (!value) return null;
      const decoded = value
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");
      const compact = decoded.replace(/\s+/g, ' ').trim();
      return compact.length > 0 ? compact : null;
    };

    const stripTags = (html: string | null): string | null => {
      if (!html) return null;
      return normalize(html.replace(/<[^>]+>/g, ' '));
    };

    const readLabelValue = (label: string): string | null => {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(
        `<li>\\s*${escaped}\\s*:\\s*([^<]+)<\\/li>`,
        'i',
      );
      const matched = sourceHtml.match(pattern);
      return normalize(matched?.[1] ?? null);
    };

    const bodyRow = sourceHtml.match(
      /<tbody[^>]*>[\s\S]*?<tr[^>]*>([\s\S]*?)<\/tr>/i,
    )?.[1];

    if (!bodyRow) {
      return {
        ...empty,
        noticePeriod: readLabelValue('입법예고기간'),
        proposalSession: readLabelValue('제안회기'),
      };
    }

    const cells = Array.from(
      bodyRow.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi),
    ).map((match) => match[1]);

    const rawCommitteeCell = cells[3] ?? null;
    const committeeMain = rawCommitteeCell
      ? rawCommitteeCell.split(/<div\s+class=['"]m_subject['"]/i)[0]
      : null;

    return {
      billNumber: stripTags(cells[0] ?? null),
      proposer: stripTags(cells[1] ?? null),
      proposalDate: stripTags(cells[2] ?? null),
      committee: stripTags(committeeMain),
      referralDate: stripTags(cells[4] ?? null),
      noticePeriod: readLabelValue('입법예고기간'),
      proposalSession: readLabelValue('제안회기'),
    };
  }

  async buildArchiveExportFile(
    noticeNum: number,
    options?: {
      changeTrackingData?: Record<string, unknown> | null;
    },
  ): Promise<ArchiveExportResult | null> {
    const row = await this.archiveRepository.findOne({
      where: { noticeNum },
    });

    if (!row) {
      return null;
    }

    await this.hydrateSummaryState(row);

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
      changeTrackingData: options?.changeTrackingData ?? null,
    });
  }

  async buildArchiveExportZip(
    noticeNum: number,
    options?: {
      changeTrackingData?: Record<string, unknown> | null;
    },
  ): Promise<{ zipFileName: string; zipBuffer: Buffer } | null> {
    const [artifacts, screenshot] = await Promise.all([
      this.buildArchiveExportFile(noticeNum, options),
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

    if (artifacts.changeTrackingFileName && artifacts.changeTrackingContent) {
      zip.file(
        artifacts.changeTrackingFileName,
        artifacts.changeTrackingContent,
      );
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
