import { MoreThan, type Repository } from 'typeorm';
import JSZip from 'jszip';
import { NoticeArchive } from '../notice-archive.entity';
import {
  NoticeArchiveIntegrityCheck,
  type ArchiveIntegrityCheckResult,
} from '../notice-archive-integrity-check.entity';
import {
  NoticeArchiveIntegrityState,
  type ArchiveIntegrityStatus,
} from '../notice-archive-integrity-state.entity';
import { NoticeArchiveSnapshotState } from '../notice-archive-summary-state.entity';
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
    private readonly integrityCheckRepository?: Repository<NoticeArchiveIntegrityCheck>,
    private readonly integrityStateRepository?: Repository<NoticeArchiveIntegrityState>,
    private readonly summaryStateRepository?: Repository<NoticeArchiveSnapshotState>,
  ) {}

  private getIntegrityStatusFromCheckResult(
    checkResult: ArchiveIntegrityCheckResult | null,
  ): ArchiveIntegrityStatus {
    if (checkResult === 'passed') return 'passed';
    if (checkResult === 'failed') return 'failed';
    if (checkResult === 'skipped') return 'skipped';
    return 'pending';
  }

  private async hydrateSummaryState(row: NoticeArchive): Promise<void> {
    if (!this.summaryStateRepository) {
      return;
    }

    const summaryState = await this.summaryStateRepository.findOne({
      where: { noticeNum: row.noticeNum },
      select: {
        isDone: true,
        aiSummary: true,
        aiSummaryStatus: true,
      },
    });

    if (!summaryState) {
      return;
    }

    row.isDone = summaryState.isDone;
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
          status: integrity.status,
          checkedAt: integrity.checkedAt,
          passed: integrity.passed,
          skipReason: integrity.skipReason,
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

  async runIntegrityScan(batchSize = 200): Promise<{
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
          noticeNum: true,
          sourceHtml: true,
          sourceHtmlSha256: true,
          integrityCheckPassed: true,
          integrityVerifiedAt: true,
        },
        order: { id: 'ASC' },
        take: batchSize,
      });

      if (rows.length === 0) break;

      for (const row of rows) {
        scanned++;
        let checkResult: ArchiveIntegrityCheckResult;
        let skipReason: string | null = null;
        let calculatedSha256: string | null = null;

        if (!row.sourceHtml || !row.sourceHtmlSha256) {
          checkResult = 'skipped';
          skipReason = 'missing_source_or_hash';
          skipped++;
        } else {
          calculatedSha256 = computeSha256(row.sourceHtml);
          checkResult =
            calculatedSha256 === row.sourceHtmlSha256 ? 'passed' : 'failed';

          if (checkResult === 'passed') {
            passed++;
          } else {
            failed++;
          }
        }

        const checkedAt = new Date();

        const createdCheck = this.integrityCheckRepository
          ? await this.integrityCheckRepository.save(
              this.integrityCheckRepository.create({
                noticeNum: row.noticeNum,
                checkedAt,
                storedSha256: row.sourceHtmlSha256,
                calculatedSha256,
                checkResult,
                skipReason,
                verifierVersion: 'integrity-scan-v2',
                diagnosticsJson: null,
              }),
            )
          : null;

        if (this.integrityStateRepository) {
          const previousState = await this.integrityStateRepository.findOne({
            where: { noticeNum: row.noticeNum },
            select: {
              id: true,
              failureStreak: true,
              lastPassedAt: true,
              createdAt: true,
            },
          });

          const failureStreak =
            checkResult === 'failed'
              ? (previousState?.failureStreak ?? 0) + 1
              : 0;

          const statePayload = {
            noticeNum: row.noticeNum,
            latestCheckId: createdCheck?.id ?? null,
            latestResult: checkResult,
            latestCheckedAt: checkedAt,
            lastPassedAt:
              checkResult === 'passed'
                ? checkedAt
                : (previousState?.lastPassedAt ?? null),
            failureStreak,
            lastSkipReason: checkResult === 'skipped' ? skipReason : null,
            latestStoredSha256: row.sourceHtmlSha256,
            latestCalculatedSha256: calculatedSha256,
          };

          if (previousState?.id) {
            await this.integrityStateRepository.update(
              { id: previousState.id },
              statePayload,
            );
          } else {
            await this.integrityStateRepository.insert(statePayload);
          }
        }

        if (!this.integrityStateRepository && !this.integrityCheckRepository) {
          await this.archiveRepository.update(
            { id: row.id },
            {
              integrityVerifiedAt: checkedAt,
              integrityCheckPassed:
                checkResult === 'passed'
                  ? true
                  : checkResult === 'failed'
                    ? false
                    : null,
            },
          );
        }
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
    status: ArchiveIntegrityStatus;
    checkedAt: Date | null;
    passed: boolean | null;
    skipReason: string | null;
    calculatedSha256: string | null;
  }> {
    if (this.integrityStateRepository) {
      const state = await this.integrityStateRepository.findOne({
        where: { noticeNum: row.noticeNum },
        select: {
          latestResult: true,
          latestCheckedAt: true,
          latestCalculatedSha256: true,
          lastSkipReason: true,
        },
      });

      if (state) {
        const status = this.getIntegrityStatusFromCheckResult(
          state.latestResult,
        );
        return {
          status,
          checkedAt: state.latestCheckedAt ?? null,
          passed:
            state.latestResult === 'passed'
              ? true
              : state.latestResult === 'failed'
                ? false
                : null,
          skipReason: state.lastSkipReason ?? null,
          calculatedSha256: state.latestCalculatedSha256 ?? null,
        };
      }
    }

    if (!row.sourceHtml || !row.sourceHtmlSha256) {
      return {
        status: 'pending',
        checkedAt: row.integrityVerifiedAt ?? null,
        passed: row.integrityCheckPassed ?? null,
        skipReason: null,
        calculatedSha256: null,
      };
    }

    if (row.integrityVerifiedAt || row.integrityCheckPassed !== null) {
      return {
        status:
          row.integrityCheckPassed === true
            ? 'passed'
            : row.integrityCheckPassed === false
              ? 'failed'
              : 'pending',
        checkedAt: row.integrityVerifiedAt ?? null,
        passed: row.integrityCheckPassed ?? null,
        skipReason: null,
        calculatedSha256:
          row.integrityCheckPassed !== null ? row.sourceHtmlSha256 : null,
      };
    }

    const calculatedSha256 = computeSha256(row.sourceHtml);
    const passed = calculatedSha256 === row.sourceHtmlSha256;

    return {
      status: passed ? 'passed' : 'failed',
      checkedAt: new Date(),
      passed,
      skipReason: null,
      calculatedSha256,
    };
  }
}
