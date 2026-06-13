import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { type INsmBillItem } from 'pal-crawl';
import { APP_CONSTANTS } from '../../config/app.config';
import { type CachedNotice } from '../../types/cache.types';
import { CacheService } from '../cache/cache.service';
import {
  NoticeArchiveService,
  type ArchiveHttpMetadata,
} from '../notice/notice-archive.service';
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

  onModuleInit(): void {
    // Fire-and-forget so it never delays module initialization.
    void this.runStartupScreenshotBackfill();
  }

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
  private async runStartupScreenshotBackfill(): Promise<void> {
    if (process.env.SCREENSHOT_REQUEUE_PAL === 'true') {
      await this.requeueAllPalScreenshots();
    }
    await this.screenshotCoordinator.backfillMissingScreenshots();
  }

  /**
   * Queues every pal.assembly.go.kr archived notice for screenshot (re-)capture.
   * Called at startup when `SCREENSHOT_REQUEUE_PAL=true`.
   */
  private async requeueAllPalScreenshots(): Promise<void> {
    try {
      const notices =
        await this.noticeArchiveService.getAllPalNoticesForScreenshotRequeue();

      if (notices.length === 0) {
        this.logger.log('PAL screenshot requeue: no notices found in archive');
        return;
      }

      this.logger.log(
        `PAL screenshot requeue: queuing ${notices.length} notice(s) for full re-capture`,
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.LOG,
        ArchiveOrchestratorService.name,
        `PAL screenshot requeue: queuing **${notices.length}** notice(s) for full re-capture`,
        { count: notices.length },
      );

      this.scheduleScreenshots(notices);
    } catch (error) {
      this.logger.warn(
        `PAL screenshot requeue failed: ${(error as Error).message}`,
      );
    }
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
            });

            // Persist the screenshot immediately if we captured it inline.
            // If capturedScreenshot is null the backfill queue will retry.
            if (capturedScreenshot) {
              try {
                await this.noticeArchiveService.updateScreenshot(
                  notice.num,
                  capturedScreenshot,
                  'jpeg',
                );
              } catch (ssErr) {
                const message =
                  ssErr instanceof Error ? ssErr.message : String(ssErr);
                this.logger.warn(
                  `Screenshot persist failed for bill ${item.billNo}: ${message} - backfill will retry`,
                );
                // Fall through: schedule via queue so backfill retries it.
                capturedScreenshot = null;
              }
            }

            if (!capturedScreenshot) {
              // Screenshot was not captured or persist failed - queue for
              // backfill so it is retried on the next backfill cron/restart.
              this.scheduleScreenshots([
                {
                  num: notice.num,
                  contentId: '',
                  isDone: false,
                  nsmBillNo: notice.num.toString(),
                },
              ]);
            }

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

    return allArchived;
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

  async handleScreenshotBackfill(): Promise<void> {
    await this.screenshotCoordinator.handleScreenshotBackfill();
  }

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
    try {
      const full = await this.crawlingCoreService.captureNsmDetailFull(billNo);
      const proposalReason = full.detail?.proposalReason?.trim() ?? '';

      if (!proposalReason) {
        return null;
      }

      const sha256 = this.computeSha256(full.html);
      const httpMetadata: ArchiveHttpMetadata = {
        requestUrl: noticeLink,
        responseUrl: full.responseUrl,
        fetchedAt: new Date().toISOString(),
        statusCode: full.statusCode,
      };

      await this.noticeArchiveService.updateNsmHtmlAndDetail(num, {
        html: full.html,
        sha256,
        proposalReason,
        httpMetadata,
        ...(full.screenshot
          ? { screenshotBlob: full.screenshot, screenshotFormat: 'jpeg' }
          : {}),
      });

      return proposalReason;
    } catch (error) {
      this.logger.warn(
        `fetchAndUpdateProposalReason failed for bill ${billNo}: ${
          (error as Error).message
        }`,
      );
      return null;
    }
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
    const { pal, nsm } =
      await this.noticeArchiveService.getNoticesWithMissingHtml(limit);

    const result = {
      pal: { ...APP_CONSTANTS.ARCHIVE_SYNC.HTML_BACKFILL_RESULT_ZERO.pal },
      nsm: { ...APP_CONSTANTS.ARCHIVE_SYNC.HTML_BACKFILL_RESULT_ZERO.nsm },
    };

    if (pal.length === 0 && nsm.length === 0) {
      LoggerUtils.debugDev(
        ArchiveOrchestratorService.name,
        'HTML backfill: no notices with missing HTML/proposalReason found',
      );
      return result;
    }

    this.logger.log(
      `HTML backfill: ${pal.length} PAL + ${nsm.length} NSM notice(s) requiring HTML/detail repair`,
    );
    void this.discordBridge?.logEvent(
      BridgeLogLevel.LOG,
      ArchiveOrchestratorService.name,
      `HTML backfill: **${pal.length}** PAL + **${nsm.length}** NSM notice(s) requiring HTML/proposalReason repair`,
      { pal: pal.length, nsm: nsm.length },
    );

    // ── PAL: concurrent plain-HTTP fetches ───────────────────────────────

    if (pal.length > 0) {
      const PAL_CONCURRENCY = 5;
      for (let i = 0; i < pal.length; i += PAL_CONCURRENCY) {
        const chunk = pal.slice(i, i + PAL_CONCURRENCY);
        await Promise.all(
          chunk.map(async ({ num, assemblyLink }) => {
            try {
              const { html, sha256, httpMetadata } =
                await this.captureNoticePageSource(assemblyLink);
              await this.noticeArchiveService.updateSourceHtml(
                num,
                html,
                sha256,
                httpMetadata,
              );
              result.pal.processed++;
              LoggerUtils.debugDev(
                ArchiveOrchestratorService.name,
                `HTML backfill PAL: stored HTML for notice ${num}`,
              );
            } catch (err) {
              result.pal.failed++;
              this.logger.warn(
                `HTML backfill PAL failed for notice ${num}: ${(err as Error).message}`,
              );
            }
          }),
        );
      }
    }

    // ── NSM: sequential Puppeteer captures with rate-limit delay ─────────

    for (let idx = 0; idx < nsm.length; idx++) {
      const { num } = nsm[idx];
      const billNo = num.toString();

      if (idx > 0) {
        await new Promise<void>((resolve) =>
          setTimeout(
            resolve,
            APP_CONSTANTS.SCREENSHOT.NSM_INTER_CAPTURE_DELAY_MS,
          ),
        );
      }

      try {
        const full =
          await this.crawlingCoreService.captureNsmDetailFull(billNo);

        const sha256 = this.computeSha256(full.html);
        const httpMetadata: ArchiveHttpMetadata = {
          requestUrl: `https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/${billNo}/detailRP`,
          responseUrl: full.responseUrl,
          fetchedAt: new Date().toISOString(),
          statusCode: full.statusCode,
        };

        const proposalReason = full.detail?.proposalReason?.trim() ?? '';

        // Also fill in screenshot if it is still missing (single Puppeteer
        // session already captured it - no extra cost).
        const hasScreenshot = full.screenshot !== null;

        await this.noticeArchiveService.updateNsmHtmlAndDetail(num, {
          html: full.html,
          sha256,
          proposalReason,
          httpMetadata,
          ...(hasScreenshot
            ? {
                screenshotBlob: full.screenshot!,
                screenshotFormat: 'jpeg',
              }
            : {}),
        });

        result.nsm.processed++;
        LoggerUtils.debugDev(
          ArchiveOrchestratorService.name,
          `HTML backfill NSM: stored HTML${hasScreenshot ? ' + screenshot' : ''} for bill ${billNo}`,
        );
      } catch (err) {
        result.nsm.failed++;
        this.logger.warn(
          `HTML backfill NSM failed for bill ${billNo}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `HTML backfill complete - PAL: ${result.pal.processed} ok / ${result.pal.failed} failed, ` +
        `NSM: ${result.nsm.processed} ok / ${result.nsm.failed} failed`,
    );

    return result;
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
