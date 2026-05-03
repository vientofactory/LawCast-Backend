import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { type CachedNotice } from '../types/cache.types';
import {
  NoticeArchiveService,
  type ArchiveHttpMetadata,
} from './notice-archive.service';
import { CrawlingCoreService } from './crawling-core.service';
import { DiscordBridgeService } from '../modules/discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../modules/discord-bridge/discord-bridge.types';

@Injectable()
export class ArchiveOrchestratorService {
  private readonly logger = new Logger(ArchiveOrchestratorService.name);

  constructor(
    private noticeArchiveService: NoticeArchiveService,
    private crawlingCoreService: CrawlingCoreService,
    @Optional() private discordBridge: DiscordBridgeService,
  ) {}

  /**
   * Archives the given notices by fetching their content and source HTML, then saving them to the archive database. This method processes notices in batches
   * to optimize performance and resource usage.
   * @param notices An array of notices to be archived.
   * @returns A promise that resolves when all notices have been processed.
   */
  async archiveNotices(notices: CachedNotice[]): Promise<void> {
    if (notices.length === 0) {
      return;
    }

    void this.discordBridge?.logEvent(
      BridgeLogLevel.LOG,
      ArchiveOrchestratorService.name,
      `Archiving **${notices.length}** notice(s)`,
      { count: notices.length },
    );

    const concurrency = 5;

    for (let i = 0; i < notices.length; i += concurrency) {
      const chunk = notices.slice(i, i + concurrency);

      await Promise.all(
        chunk.map(async (notice) => {
          let proposalReason = '';
          let sourceTitle: string | null = notice.subject;
          let contentBillNumber: string | null = null;
          let contentProposer: string | null = null;
          let contentProposalDate: string | null = null;
          let contentCommittee: string | null = null;
          let contentReferralDate: string | null = null;
          let contentNoticePeriod: string | null = null;
          let contentProposalSession: string | null = null;
          let sourceHtml: string | null = null;
          let sourceHtmlSha256: string | null = null;
          let httpMetadata: ArchiveHttpMetadata | null = null;
          const archivedAt = new Date();

          if (notice.contentId) {
            try {
              const content = await this.crawlingCoreService.getContent(
                notice.contentId,
              );
              proposalReason = content?.proposalReason?.trim() || '';
              sourceTitle = content?.title?.trim() || notice.subject;
              contentBillNumber = content?.billNumber?.trim() || null;
              contentProposer = content?.proposer?.trim() || null;
              contentProposalDate = content?.proposalDate?.trim() || null;
              contentCommittee = content?.committee?.trim() || null;
              contentReferralDate = content?.referralDate?.trim() || null;
              contentNoticePeriod = content?.noticePeriod?.trim() || null;
              contentProposalSession = content?.proposalSession?.trim() || null;
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              this.logger.warn(
                `Failed to fetch original content for archive notice ${notice.num}: ${message}`,
              );
              void this.discordBridge?.logEvent(
                BridgeLogLevel.VERBOSE,
                ArchiveOrchestratorService.name,
                `Content fetch failed for notice **${notice.num}**: ${message}`,
                { noticeNum: notice.num, contentId: notice.contentId },
              );
            }
          }

          try {
            const sourceCapture = await this.captureNoticePageSource(
              notice.link,
            );
            sourceHtml = sourceCapture.html;
            sourceHtmlSha256 = sourceCapture.sha256;
            httpMetadata = sourceCapture.httpMetadata;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            this.logger.warn(
              `Failed to capture source HTML for archive notice ${notice.num}: ${message}`,
            );
            void this.discordBridge?.logEvent(
              BridgeLogLevel.VERBOSE,
              ArchiveOrchestratorService.name,
              `HTML capture failed for notice **${notice.num}**: ${message}`,
              { noticeNum: notice.num, link: notice.link },
            );
          }

          try {
            await this.noticeArchiveService.upsertNoticeArchive(notice, {
              proposalReason,
              title: sourceTitle,
              billNumber: contentBillNumber,
              proposer: contentProposer,
              proposalDate: contentProposalDate,
              committee: contentCommittee,
              referralDate: contentReferralDate,
              noticePeriod: contentNoticePeriod,
              proposalSession: contentProposalSession,
              sourceHtml,
              htmlSha256: sourceHtmlSha256,
              archivedAt,
              httpMetadata,
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            this.logger.error(
              `Failed to archive notice ${notice.num}: ${message}`,
              error,
            );
          }
        }),
      );
    }
  }

  /**
   * Filters out notices that have already been archived.
   * @param notices An array of notices to be filtered.
   * @returns A promise that resolves to an array of notices that are not yet archived.
   */
  async filterAlreadyArchivedNotices<T extends { num: number }>(
    notices: T[],
  ): Promise<T[]> {
    if (notices.length === 0) {
      return [];
    }

    const existingNoticeNums =
      await this.noticeArchiveService.getExistingNoticeNumSet(
        notices.map((notice) => notice.num),
      );

    const filtered = notices.filter(
      (notice) => !existingNoticeNums.has(notice.num),
    );

    void this.discordBridge?.logEvent(
      BridgeLogLevel.VERBOSE,
      ArchiveOrchestratorService.name,
      `Archive filter: **${filtered.length}** new out of **${notices.length}** (${notices.length - filtered.length} already archived)`,
      {
        total: notices.length,
        newCount: filtered.length,
        alreadyArchived: notices.length - filtered.length,
      },
    );

    return filtered;
  }

  /**
   * Computes the SHA-256 hash of the given input string.
   * @param input The input string to hash.
   * @returns The SHA-256 hash of the input string.
   */
  private computeSha256(input: string): string {
    return createHash('sha256').update(input, 'utf8').digest('hex');
  }

  /**
   * Fetches the HTML source of the notice page and captures relevant HTTP metadata.
   * @param link The URL of the notice page to capture.
   * @returns An object containing the captured HTML, its SHA-256 hash, and HTTP metadata.
   * @throws Will throw an error if the fetch operation fails or if the captured HTML is empty.
   */
  private async captureNoticePageSource(link: string): Promise<{
    html: string;
    sha256: string;
    httpMetadata: ArchiveHttpMetadata;
  }> {
    const response = await globalThis.fetch(link, {
      method: 'GET',
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; Lawcast/1.0)',
      },
      redirect: 'follow',
    });

    const html = await response.text();

    if (!html.trim()) {
      throw new Error('Captured HTML is empty');
    }

    return {
      html,
      sha256: this.computeSha256(html),
      httpMetadata: {
        requestUrl: link,
        responseUrl: response.url,
        fetchedAt: new Date().toISOString(),
        statusCode: response.status,
        contentType: response.headers.get('content-type') || undefined,
        etag: response.headers.get('etag') || undefined,
        lastModified: response.headers.get('last-modified') || undefined,
      },
    };
  }
}
