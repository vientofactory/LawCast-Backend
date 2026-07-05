import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { type INsmBillItem } from 'pal-crawl';
import { APP_CONSTANTS } from '../../config/app.config';
import { type CachedNotice } from '../../types/cache.types';
import { CacheService } from '../cache/cache.service';
import {
  NoticeArchiveService,
  type ArchiveHttpMetadata,
} from '../notice/notice-archive.service';
import { computeSha256 as computeSha256Hex } from '../notice/notice-archive.helpers';
import { CrawlingCoreService } from './crawling-core.service';
import { DiscordBridgeService } from '../discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../discord-bridge/discord-bridge.types';
import { LoggerUtils } from '../../utils/logger.utils';
import { ArchiveOrchestratorScreenshotCoordinator } from './utils/archive-orchestrator-screenshot-coordinator';

@Injectable()
export class ArchiveOrchestratorService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(ArchiveOrchestratorService.name);
  private readonly screenshotCoordinator: ArchiveOrchestratorScreenshotCoordinator;

  constructor(
    private readonly cacheService: CacheService,
    private noticeArchiveService: NoticeArchiveService,
    private crawlingCoreService: CrawlingCoreService,
    @Optional() private discordBridge: DiscordBridgeService,
  ) {
    this.screenshotCoordinator = new ArchiveOrchestratorScreenshotCoordinator({
      cacheService: this.cacheService,
      noticeArchiveService: this.noticeArchiveService,
      crawlingCoreService: this.crawlingCoreService,
      logger: this.logger,
      discordBridge: this.discordBridge,
    });
  }

  onModuleInit(): void {}

  /**
   * Startup screenshot pipeline.
   *
   * When `SCREENSHOT_REQUEUE_PAL=true` is set, every pal.assembly.go.kr notice
   * (contentId NOT NULL) is queued for screenshot re-capture - including rows
   * that already have a screenshot - before the normal missing-screenshot
   * backfill runs.  The `scheduleScreenshots` deduplication means the normal
   * backfill will then only add any NsmLmSts notices that were not already
   * enqueued by the forced requeue.
   *
   * Without the flag this behaves identically to the previous single-call
   * `backfillMissingScreenshots()` path.
   */
  private async runStartupScreenshotBackfill(): Promise<void> {}

  /**
   * Queues every pal.assembly.go.kr archived notice for screenshot (re-)capture.
   * Called at startup when `SCREENSHOT_REQUEUE_PAL=true`.
   */
  private async requeueAllPalScreenshots(): Promise<void> {}

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

    this.noticeArchiveService.beginChangeNotificationCollection();

    try {
      void this.discordBridge?.logEvent(
        BridgeLogLevel.LOG,
        ArchiveOrchestratorService.name,
        `Archiving **${notices.length}** notice(s)`,
        { count: notices.length },
      );

      const concurrency =
        this.noticeArchiveService.getRecommendedWriteConcurrency?.(5) ?? 5;
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

      await this.noticeArchiveService.flushQueuedChangeNotifications();

      return savedCount;
    } finally {
      await this.noticeArchiveService.endChangeNotificationCollection();
    }
  }

  /**
   * Archives NsmLmSts pending bills (발의 상태) by fetching their full detail page
   * (proposalReason, proposalInfo, session, etc.) and persisting everything to
   * the archive database.
   *
   * Unlike `archiveNotices`, this method fetches NsmLmSts detail directly
   * rather than relying on a pal.assembly.go.kr contentId (which does not
   * exist yet for bills that have not entered the formal 입법예고 process).
   *
   * Screenshots are scheduled as a fire-and-forget background task, matching
   * the behaviour of `archiveNotices` for pal.assembly.go.kr bills.
   *
   * @param items Raw INsmBillItem entries returned by NsmLmSts list pages.
   * @returns Successfully archived CachedNotice objects with `proposalReason`
   *   populated, ready for AI summary generation by the caller.
   */
  async archiveNsmBillItems(items: INsmBillItem[]): Promise<CachedNotice[]> {
    if (items.length === 0) {
      return [];
    }

    this.noticeArchiveService.beginChangeNotificationCollection();

    try {
      void this.discordBridge?.logEvent(
        BridgeLogLevel.LOG,
        ArchiveOrchestratorService.name,
        `Archiving **${items.length}** pending bill(s) from NsmLmSts`,
        { count: items.length },
      );

      const allArchived: CachedNotice[] = [];

      // Process NSM items sequentially to avoid rate-limiting on
      // opinion.lawmaking.go.kr.  Each iteration opens a Puppeteer browser
      // so concurrent sessions from the same IP would trigger the Waitingroom
      // anti-bot / rate limiter.  NSM_INTER_CAPTURE_DELAY_MS is applied between
      // items (matching the same guard used in drainScreenshotQueue).
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];

        // Inter-item delay for every item after the first.
        if (idx > 0) {
          await new Promise<void>((resolve) =>
            setTimeout(
              resolve,
              APP_CONSTANTS.SCREENSHOT.NSM_INTER_CAPTURE_DELAY_MS,
            ),
          );
        }

        const result = await (async (): Promise<CachedNotice | null> => {
          try {
            const notice = CrawlingCoreService.nsmBillToCachedNotice(item);
            const archivedAt = new Date();

            // Single Puppeteer session: HTML capture + screenshot + detail parse.
            // Previously these required getNsmDetail (plain HTTP, often blocked by
            // Waitingroom) + captureNsmDetailHtml (Puppeteer #1) + a deferred
            // captureNsmDetailScreenshot (Puppeteer #2).  captureNsmDetailFull
            // collapses all three into one browser launch.
            let proposalReason = '';
            let sourceTitle: string | null = item.billName;
            let contentBillNumber: string | null = null;
            let contentProposer: string | null = null;
            let contentProposalDate: string | null = null;
            let contentProposalSession: string | null = null;
            let sourceHtml: string | null = null;
            let sourceHtmlSha256: string | null = null;
            let httpMetadata: ArchiveHttpMetadata | null = null;
            let capturedScreenshot: Buffer | null = null;

            try {
              const full = await this.crawlingCoreService.captureNsmDetailFull(
                item.billNo,
              );

              // HTML / metadata
              sourceHtml = full.html;
              sourceHtmlSha256 = this.computeSha256(full.html);
              httpMetadata = {
                requestUrl: notice.link,
                responseUrl: full.responseUrl,
                fetchedAt: new Date().toISOString(),
                statusCode: full.statusCode,
              };

              // Detail fields parsed from the same page HTML
              if (full.detail) {
                proposalReason = full.detail.proposalReason?.trim() ?? '';
                sourceTitle = full.detail.proposalInfo?.trim() || item.billName;
                contentBillNumber = full.detail.billNo?.trim() || null;
                contentProposer = full.detail.proposer?.trim() || null;
                contentProposalDate = full.detail.proposalDate?.trim() || null;
                contentProposalSession = full.detail.session?.trim() || null;
              }

              // Screenshot captured in the same session
              capturedScreenshot = full.screenshot;
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              this.logger.warn(
                `captureNsmDetailFull failed for bill ${item.billNo}: ${message}`,
              );
              void this.discordBridge?.logEvent(
                BridgeLogLevel.VERBOSE,
                ArchiveOrchestratorService.name,
                `NsmLmSts full capture failed for bill **${item.billNo}**: ${message}`,
                { billNo: item.billNo },
              );
            }

            try {
              await this.noticeArchiveService.upsertNoticeArchive(notice, {
                proposalReason,
                title: sourceTitle,
                billNumber: contentBillNumber,
                proposer: contentProposer,
                proposalDate: contentProposalDate,
                proposalSession: contentProposalSession,
                sourceHtml,
                htmlSha256: sourceHtmlSha256,
                archivedAt,
                httpMetadata,
                screenshotBlob: capturedScreenshot,
                screenshotFormat: capturedScreenshot ? 'jpeg' : null,
              });

              const enriched: CachedNotice = {
                ...notice,
                proposalReason: proposalReason || null,
              };
              return enriched;
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              this.logger.error(
                `Failed to archive pending bill ${item.billNo}: ${message}`,
                error,
              );
              return null;
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            this.logger.error(
              `Unexpected error while archiving pending bill ${item.billNo}: ${message}`,
              error,
            );
            return null;
          }
        })();

        if (result !== null) {
          allArchived.push(result);
        }
      }

      await this.noticeArchiveService.flushQueuedChangeNotifications();

      return allArchived;
    } finally {
      await this.noticeArchiveService.endChangeNotificationCollection();
    }
  }

  /**
   * Enqueues notices for background screenshot capture.
   * Safe to call from outside this class (e.g. bootstrap backfill).
   * If a drain loop is already running the items are appended to the queue
   * and will be processed automatically - no second Puppeteer instance starts.
   */
  scheduleScreenshots(
    items: Array<{
      num: number;
      contentId: string;
      isDone: boolean;
      nsmBillNo?: string;
    }>,
  ): void {
    this.screenshotCoordinator.scheduleScreenshots(items);
  }

  /**
   * Drain loop: processes every notice in `screenshotQueue` one at a time
   * (sequential, bounded Puppeteer memory) until the queue is empty.
   * Sets `isCaptureRunning` for the duration so concurrent archiving cycles
   * that call `scheduleScreenshots` simply append to the queue instead of
   * spawning a second loop.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    await this.screenshotCoordinator.handleShutdown(signal);
  }

  async handleScreenshotBackfill(): Promise<void> {}

  // ─────────────────────────────────────────────────────────────────────────
  // proposalReason on-demand retry
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Re-fetches NsmLmSts detail for a single bill and, if `proposalReason` is
   * successfully obtained, persists the updated HTML + detail to the archive.
   *
   * Called by the proposalReason retry queue in CrawlingSchedulerService for
   * bills that were archived with an empty `proposalReason` on first attempt.
   *
   * @returns The trimmed `proposalReason` string on success, or `null` when
   *   the capture fails or the detail page still has no reason text.
   */
  async fetchAndUpdateProposalReason(
    num: number,
    billNo: string,
    noticeLink: string,
  ): Promise<string | null> {
    void num;
    void billNo;
    void noticeLink;
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HTML backfill
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Re-fetches source HTML/detail for archived notices that still have
   * `sourceHtml = NULL`, plus NsmLmSts rows with empty `proposalReason`.
   *
   * Two capture strategies:
   *  - **PAL** (`contentId NOT NULL`): plain HTTP fetch via
   *    `captureNoticePageSource` - fast, no Puppeteer required.
   *  - **NSM** (`contentId IS NULL`): `captureNsmDetailFull` via Puppeteer
   *    with Waitingroom bypass - also updates `proposalReason` and fills in
   *    the screenshot if it too is missing.
   *
   * NSM requests are rate-limited with `NSM_INTER_CAPTURE_DELAY_MS` between
   * items; PAL requests run concurrently (capped at 5 in-flight).
   *
   * Called from the bootstrap pipeline (before the summary-backfill phase so
   * `proposalReason` is available for Ollama summarisation).
   */
  async backfillMissingHtml(limit: number): Promise<{
    pal: { processed: number; failed: number };
    nsm: { processed: number; failed: number };
  }> {
    void limit;
    LoggerUtils.debugDev(
      ArchiveOrchestratorService.name,
      'HTML backfill skipped: notice_archives is immutable',
    );
    return {
      pal: { ...APP_CONSTANTS.ARCHIVE_SYNC.HTML_BACKFILL_RESULT_ZERO.pal },
      nsm: { ...APP_CONSTANTS.ARCHIVE_SYNC.HTML_BACKFILL_RESULT_ZERO.nsm },
    };
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
   * Computes SHA-256 hash for archived HTML payloads.
   */
  private computeSha256(input: string): string {
    return computeSha256Hex(input);
  }

  /**
   * Fetches the HTML source of the notice page and captures relevant HTTP metadata.
   * @param link The URL of the notice page to capture.
   * @returns An object containing the captured HTML, its SHA-256 hash, and HTTP metadata.
   * @throws Will throw an error if the fetch operation fails, returns a non-2xx status,
   *   or if the captured HTML is empty.
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
        'User-Agent': APP_CONSTANTS.CRAWLING.USER_AGENT,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText} fetching ${link}`,
      );
    }

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
