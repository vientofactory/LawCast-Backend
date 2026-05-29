import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { APP_CONSTANTS } from '../config/app.config';
import { type CachedNotice } from '../types/cache.types';
import {
  NoticeArchiveService,
  type ArchiveHttpMetadata,
} from './notice-archive.service';
import { CrawlingCoreService } from './crawling-core.service';
import { DiscordBridgeService } from '../modules/discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../modules/discord-bridge/discord-bridge.types';
import { LoggerUtils } from '../utils/logger.utils';

@Injectable()
export class ArchiveOrchestratorService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(ArchiveOrchestratorService.name);

  /** Minimal payload stored in the screenshot queue. */
  private readonly screenshotQueue: Array<{
    num: number;
    contentId: string;
    isDone: boolean;
  }> = [];
  /** Prevents two concurrent Puppeteer screenshot runs. */
  private isCaptureRunning = false;

  constructor(
    private noticeArchiveService: NoticeArchiveService,
    private crawlingCoreService: CrawlingCoreService,
    @Optional() private discordBridge: DiscordBridgeService,
  ) {}

  onModuleInit(): void {
    // Backfill screenshots for already-archived notices that have never had
    // a screenshot captured (e.g. pre-screenshot-feature rows, or notices
    // where the previous Puppeteer session crashed).
    // Fire-and-forget so it never delays module initialization.
    void this.backfillMissingScreenshots();
  }

  /**
   * Archives the given notices by fetching their content and source HTML, then saving them to the archive database. This method processes notices in batches
   * to optimize performance and resource usage.
   * @param notices An array of notices to be archived.
   * @returns The number of notices successfully saved to the archive.
   */
  async archiveNotices(notices: CachedNotice[]): Promise<number> {
    if (notices.length === 0) {
      return 0;
    }

    void this.discordBridge?.logEvent(
      BridgeLogLevel.LOG,
      ArchiveOrchestratorService.name,
      `Archiving **${notices.length}** notice(s)`,
      { count: notices.length },
    );

    const concurrency = 5;
    let savedCount = 0;
    const archivedNotices: CachedNotice[] = [];

    for (let i = 0; i < notices.length; i += concurrency) {
      const chunk = notices.slice(i, i + concurrency);

      const chunkResults = await Promise.all(
        chunk.map(async (notice) => {
          // Outer guard: any unexpected throw must not reject the whole Promise.all chunk
          try {
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
                contentProposalSession =
                  content?.proposalSession?.trim() || null;
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
              return notice;
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              this.logger.error(
                `Failed to archive notice ${notice.num}: ${message}`,
                error,
              );
              return null;
            }
          } catch (error) {
            // Catch-all for unexpected throws outside the inner try/catch blocks
            const message =
              error instanceof Error ? error.message : String(error);
            this.logger.error(
              `Unexpected error while archiving notice ${notice.num}: ${message}`,
              error,
            );
            return null;
          }
        }),
      );

      const saved = chunkResults.filter((r): r is CachedNotice => r !== null);
      savedCount += saved.length;
      archivedNotices.push(...saved);
    }

    // Fire-and-forget: screenshots run in the background so archiveNotices
    // returns immediately.  A single drain loop (guarded by isCaptureRunning)
    // ensures at most one Puppeteer instance is live at any time.
    this.scheduleScreenshots(
      archivedNotices
        .filter((n) => n.contentId)
        .map((n) => ({ num: n.num, contentId: n.contentId!, isDone: false })),
    );

    return savedCount;
  }

  /**
   * Enqueues notices for background screenshot capture.
   * Safe to call from outside this class (e.g. bootstrap backfill).
   * If a drain loop is already running the items are appended to the queue
   * and will be processed automatically — no second Puppeteer instance starts.
   */
  scheduleScreenshots(
    items: Array<{ num: number; contentId: string; isDone: boolean }>,
  ): void {
    if (items.length === 0) return;

    // Deduplicate: skip notices already waiting in the queue to avoid
    // redundant Puppeteer captures when backfill and a cron cycle overlap.
    const queuedNums = new Set(this.screenshotQueue.map((q) => q.num));
    const deduped = items.filter((item) => !queuedNums.has(item.num));

    if (deduped.length === 0) return;

    this.screenshotQueue.push(...deduped);
    LoggerUtils.debug(
      ArchiveOrchestratorService.name,
      `Queued ${deduped.length} notice(s) for screenshot capture ` +
        `(${items.length - deduped.length} duplicate(s) skipped, ` +
        `queue depth: ${this.screenshotQueue.length}, running: ${this.isCaptureRunning})`,
    );

    if (!this.isCaptureRunning) {
      // Start the drain loop asynchronously
      void this.drainScreenshotQueue();
    }
  }

  /**
   * Drain loop: processes every notice in `screenshotQueue` one at a time
   * (sequential, bounded Puppeteer memory) until the queue is empty.
   * Sets `isCaptureRunning` for the duration so concurrent archiving cycles
   * that call `scheduleScreenshots` simply append to the queue instead of
   * spawning a second loop.
   */
  private async drainScreenshotQueue(): Promise<void> {
    if (this.isCaptureRunning) return;
    this.isCaptureRunning = true;

    try {
      while (this.screenshotQueue.length > 0) {
        const notice = this.screenshotQueue.shift()!;

        try {
          const screenshot =
            await this.crawlingCoreService.captureContentScreenshot(
              notice.contentId,
              notice.isDone,
            );

          if (screenshot) {
            await this.noticeArchiveService.updateScreenshot(
              notice.num,
              screenshot,
              'jpeg',
            );
            LoggerUtils.debug(
              ArchiveOrchestratorService.name,
              `Screenshot stored for notice ${notice.num} (${screenshot.length.toLocaleString()} Bytes)`,
            );
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Screenshot capture/store failed for notice ${notice.num}: ${message}`,
          );
        }
      }
    } finally {
      this.isCaptureRunning = false;
    }
  }

  /**
   * NestJS OnApplicationShutdown hook.
   * Logs any notices that are still waiting to be screenshotted so operators
   * know work was left pending (screenshots are non-critical and will be
   * retried on the next archiving cycle).
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    const pending = this.screenshotQueue.length;
    const inProgress = this.isCaptureRunning ? 1 : 0;

    if (pending > 0 || inProgress > 0) {
      this.logger.warn(
        `Shutdown (${signal ?? 'unknown'}) with ${pending} screenshot(s) ` +
          `queued and ${inProgress} in progress - they will be skipped.`,
      );
    }

    // Clear the queue so the drain loop exits on its next iteration.
    this.screenshotQueue.length = 0;
  }

  /**
   * Finds archived notices that have a contentId but no screenshot and feeds
   * them into the screenshot queue.
   *
   * Capped at SCREENSHOT.BACKFILL_BATCH_SIZE per startup so a large legacy DB
   * doesn't flood Puppeteer.  Subsequent restarts will backfill the next batch,
   * gradually filling in every missing screenshot over time.
   */
  private async backfillMissingScreenshots(): Promise<void> {
    try {
      const missing =
        await this.noticeArchiveService.getNoticesWithMissingScreenshots(
          APP_CONSTANTS.SCREENSHOT.BACKFILL_BATCH_SIZE,
        );

      if (missing.length === 0) {
        LoggerUtils.debug(
          ArchiveOrchestratorService.name,
          'Screenshot backfill: no missing screenshots found',
        );
        return;
      }

      this.logger.log(
        `Screenshot backfill: queuing ${missing.length} notice(s) with missing screenshots`,
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.LOG,
        ArchiveOrchestratorService.name,
        `Screenshot backfill: queuing **${missing.length}** notice(s)`,
        { count: missing.length },
      );

      this.scheduleScreenshots(missing);
    } catch (error) {
      this.logger.warn(
        `Screenshot backfill failed: ${(error as Error).message}`,
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
