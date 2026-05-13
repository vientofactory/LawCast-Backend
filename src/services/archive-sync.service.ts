import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { type ITableData, type ISearchResult } from 'pal-crawl';
import { APP_CONSTANTS } from '../config/app.config';
import { CrawlingCoreService } from './crawling-core.service';
import { NoticeArchiveService } from './notice-archive.service';
import { ArchiveOrchestratorService } from './archive-orchestrator.service';
import { SummaryGenerationService } from './summary-generation.service';
import { DiscordBridgeService } from '../modules/discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../modules/discord-bridge/discord-bridge.types';
import { LoggerUtils } from '../utils/logger.utils';

// ─── Tuning constants (sourced from APP_CONSTANTS.ARCHIVE_SYNC) ───────────────

const {
  CRAWLER_PAGE_UNIT,
  CRAWLER_DELAY_MS,
  DONE_BATCH_SIZE,
  INTEGRITY_BATCH_SIZE,
  SUMMARY_BACKFILL_BATCH_SIZE,
} = APP_CONSTANTS.ARCHIVE_SYNC;
/** Max concurrent Ollama calls within a single backfill / retry batch. */
const SUMMARY_BACKFILL_CONCURRENCY = APP_CONSTANTS.CRAWLING.SUMMARY_CONCURRENCY;

/**
 * Application-level per-page retry budget for the isDone done-page crawler.
 * Operates on top of pal-crawl's own HTTP-level retries so a brief server
 * outage that exhausts the lower-level retries is still recoverable without
 * restarting the entire sync from page 1.
 */
const DONE_PAGE_MAX_RETRIES = 2;
/** Base backoff between done-page retry attempts (ms); multiplied by attempt number. */
const DONE_PAGE_RETRY_BASE_MS = 500;

// ─── Public types ─────────────────────────────────────────────────────────────

export type SyncPhaseStatus = 'idle' | 'running' | 'failed';

/**
 * Generic status snapshot returned by each `getXxxStatus()` accessor.
 * All three sync phases share the same shape - only the result type differs.
 */
export interface PhaseStatus<TResult> {
  status: SyncPhaseStatus;
  lastRunAt: string | null;
  lastResult: TResult | null;
  lastError: string | null;
}

export interface FullSyncResult {
  totalPagesScanned: number;
  totalNoticesScanned: number;
  newlyArchivedCount: number;
}

export interface IsDoneSyncResult {
  fetchedDoneCount: number;
  markedDoneCount: number;
  revertedCount: number;
  totalScanned: number;
}

export interface IntegrityCheckResult {
  scanned: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface SummaryBackfillResult {
  scanned: number;
  generated: number;
  skipped: number;
  failed: number;
}

/**
 * Result of a single unavailable-summary retry pass.
 * `recovered` = rows that transitioned to `'ready'`;
 * `skipped` = rows that became `'not_supported'`;
 * `stillFailed` = rows that remain `'unavailable'` after retry.
 */
export interface SummaryUnavailableRetryResult {
  scanned: number;
  recovered: number;
  skipped: number;
  stillFailed: number;
}

export type FullSyncStatus = PhaseStatus<FullSyncResult>;
export type IsDoneSyncStatus = PhaseStatus<IsDoneSyncResult>;
export type IntegrityCheckStatus = PhaseStatus<IntegrityCheckResult>;
export type SummaryBackfillStatus = PhaseStatus<SummaryBackfillResult>;
export type SummaryUnavailableRetryStatus =
  PhaseStatus<SummaryUnavailableRetryResult>;

// ─── Internal tracker ─────────────────────────────────────────────────────────

/** Extends PhaseStatus with an in-progress guard. Never exposed externally. */
interface PhaseTracker<TResult> extends PhaseStatus<TResult> {
  isRunning: boolean;
}

function makeTracker<T>(): PhaseTracker<T> {
  return {
    isRunning: false,
    status: 'idle',
    lastRunAt: null,
    lastResult: null,
    lastError: null,
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Unified service that manages the complete archive synchronisation pipeline:
 *
 *  1. **Full sync** - streams all active legislative notices via
 *     `CrawlingCoreService.getAllPages` and archives any records that are
 *     missing from the DB, including their source HTML and content metadata.
 *
 *  2. **isDone sync** - two-phase reconciliation that marks notices as done
 *     and reverts stale done-flags, keeping the `isDone` column consistent
 *     with the crawler's done-notice registry.
 *
 *  3. **Integrity check** - scans every archive record and re-verifies the
 *     stored SHA-256 hash against the raw `sourceHtml`, persisting results
 *     back to `integrityVerifiedAt` / `integrityCheckPassed`.
 *
 * On module init the three phases are executed sequentially as a bootstrap
 * pipeline so the DB is fully reconciled before the first scheduled cron tick.
 */
@Injectable()
export class ArchiveSyncService implements OnModuleInit {
  // ── Phase trackers ───────────────────────────────────────────────────────

  private readonly fullSync = makeTracker<FullSyncResult>();
  private readonly isDoneSync = makeTracker<IsDoneSyncResult>();
  private readonly integrityCheck = makeTracker<IntegrityCheckResult>();
  private readonly summaryBackfill = makeTracker<SummaryBackfillResult>();
  private readonly unavailableRetry =
    makeTracker<SummaryUnavailableRetryResult>();

  constructor(
    private readonly crawlingCoreService: CrawlingCoreService,
    private readonly noticeArchiveService: NoticeArchiveService,
    private readonly archiveOrchestratorService: ArchiveOrchestratorService,
    private readonly summaryGenerationService: SummaryGenerationService,
    @Optional() private readonly discordBridge: DiscordBridgeService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  onModuleInit(): void {
    LoggerUtils.logDev(
      ArchiveSyncService.name,
      'Scheduling bootstrap sync pipeline in background…',
    );
    void this.runBootstrapPipeline();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Bootstrap pipeline
  // ─────────────────────────────────────────────────────────────────────────

  private async runBootstrapPipeline(): Promise<void> {
    LoggerUtils.log(ArchiveSyncService.name, 'Bootstrap sync pipeline started');
    void this.discordBridge?.logEvent(
      BridgeLogLevel.LOG,
      ArchiveSyncService.name,
      'Bootstrap sync pipeline started',
    );

    await this.safeRun('full sync', () => this.runFullSync('bootstrap'));
    await this.safeRun('isDone sync', () => this.runIsDoneSync('bootstrap'));
    await this.safeRun('integrity check', () =>
      this.runIntegrityCheck('bootstrap'),
    );
    await this.safeRun('summary backfill', () =>
      this.runSummaryBackfill('bootstrap'),
    );
    await this.safeRun('unavailable retry', () =>
      this.runUnavailableRetry('bootstrap'),
    );

    LoggerUtils.log(
      ArchiveSyncService.name,
      'Bootstrap sync pipeline complete',
    );
    void this.discordBridge?.logEvent(
      BridgeLogLevel.LOG,
      ArchiveSyncService.name,
      'Bootstrap sync pipeline complete',
    );
  }

  /** Runs a named async operation, swallowing errors so the pipeline continues. */
  private async safeRun(
    label: string,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await fn();
    } catch (error) {
      LoggerUtils.error(
        ArchiveSyncService.name,
        `[bootstrap] ${label} failed: ${(error as Error).message}`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Generic phase runner
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns true if any phase is currently executing.
   * Used by cron-triggered phases to avoid starting while another
   * heavy phase (e.g. isDone sync vs integrity rescan) is in progress.
   */
  isAnyPhaseRunning(): boolean {
    return (
      this.fullSync.isRunning ||
      this.isDoneSync.isRunning ||
      this.integrityCheck.isRunning ||
      this.summaryBackfill.isRunning ||
      this.unavailableRetry.isRunning
    );
  }

  /**
   * Returns the name of the currently running phase, or null if idle.
   * Used for logging when a cron-triggered phase is skipped.
   */
  private runningPhaseName(): string | null {
    if (this.fullSync.isRunning) return 'full sync';
    if (this.isDoneSync.isRunning) return 'isDone sync';
    if (this.integrityCheck.isRunning) return 'integrity check';
    if (this.summaryBackfill.isRunning) return 'summary backfill';
    if (this.unavailableRetry.isRunning) return 'unavailable retry';
    return null;
  }

  /**
   * Guards against concurrent runs, tracks phase state, fires a Discord log
   * on success, and re-throws on failure after setting `status='failed'`.
   *
   * @param crossPhaseGuard When true (default for cron-triggered phases),
   *   also skips if any *other* phase is already running to prevent
   *   concurrent DB writes across phases.
   * @returns `null` if a phase is already running, otherwise the task result.
   */
  private async runPhase<T>(
    phaseName: string,
    tracker: PhaseTracker<T>,
    trigger: string,
    task: () => Promise<T>,
    formatResult?: (result: T) => string,
    crossPhaseGuard = false,
  ): Promise<T | null> {
    if (tracker.isRunning) {
      LoggerUtils.warn(
        ArchiveSyncService.name,
        `${phaseName} already in progress - skipping [${trigger}]`,
      );
      return null;
    }

    if (crossPhaseGuard) {
      const running = this.runningPhaseName();
      if (running) {
        LoggerUtils.warn(
          ArchiveSyncService.name,
          `${phaseName} skipped - another phase is in progress (${running}) [${trigger}]`,
        );
        void this.discordBridge?.logEvent(
          BridgeLogLevel.WARN,
          ArchiveSyncService.name,
          `**${phaseName}** skipped - \`${running}\` is already running [${trigger}]`,
        );
        return null;
      }
    }

    tracker.isRunning = true;
    tracker.status = 'running';
    tracker.lastError = null;

    try {
      const result = await task();
      tracker.status = 'idle';
      tracker.lastRunAt = new Date().toISOString();
      tracker.lastResult = result;
      tracker.lastError = null;
      if (formatResult) {
        void this.discordBridge?.logEvent(
          BridgeLogLevel.DEBUG,
          ArchiveSyncService.name,
          `[${trigger}] ${phaseName} - ${formatResult(result)}`,
        );
      }
      return result;
    } catch (error) {
      tracker.status = 'failed';
      tracker.lastRunAt = new Date().toISOString();
      tracker.lastError =
        error instanceof Error ? error.message : String(error);
      void this.discordBridge?.logEvent(
        BridgeLogLevel.ERROR,
        ArchiveSyncService.name,
        `[${trigger}] **${phaseName}** failed - ${(error as Error).message}`,
      );
      throw error;
    } finally {
      tracker.isRunning = false;
    }
  }

  /** Returns a status snapshot without the internal `isRunning` flag. */
  private static toStatus<T>(tracker: PhaseTracker<T>): PhaseStatus<T> {
    const { isRunning: _, ...status } = tracker;
    return status;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 1 – Full archive sync
  // ─────────────────────────────────────────────────────────────────────────

  async runFullSync(trigger: string): Promise<FullSyncResult | null> {
    return this.runPhase(
      'Full sync',
      this.fullSync,
      trigger,
      () => this.executeFullSync(),
      (r) =>
        `pages=${r.totalPagesScanned} scanned=${r.totalNoticesScanned} archived=${r.newlyArchivedCount}`,
    );
  }

  getFullSyncStatus(): FullSyncStatus {
    return ArchiveSyncService.toStatus(this.fullSync);
  }

  private async executeFullSync(): Promise<FullSyncResult> {
    LoggerUtils.logDev(ArchiveSyncService.name, 'Full archive sync started');

    let totalPagesScanned = 0;
    let totalNoticesScanned = 0;
    let newlyArchivedCount = 0;

    for await (const page of this.crawlingCoreService.getAllPages(
      { pageUnit: CRAWLER_PAGE_UNIT },
      { delayMs: CRAWLER_DELAY_MS, concurrency: 1 },
    )) {
      totalPagesScanned++;
      // Guard against unexpected null/undefined items from the crawler
      const pageItems: ITableData[] = page.items ?? [];
      totalNoticesScanned += pageItems.length;

      const newNotices =
        await this.archiveOrchestratorService.filterAlreadyArchivedNotices(
          pageItems,
        );

      if (newNotices.length > 0) {
        const saved = await this.archiveOrchestratorService.archiveNotices(
          newNotices.map((n) => ({
            ...n,
            aiSummary: null,
            aiSummaryStatus: 'not_requested' as const,
          })),
        );
        newlyArchivedCount += saved;
      }

      LoggerUtils.debugDev(
        ArchiveSyncService.name,
        `Page ${page.currentPage}/${page.totalPages}: ` +
          `total=${pageItems.length} new=${newNotices.length}`,
      );
    }

    return { totalPagesScanned, totalNoticesScanned, newlyArchivedCount };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 2 – isDone sync
  // ─────────────────────────────────────────────────────────────────────────

  async runIsDoneSync(trigger: string): Promise<IsDoneSyncResult | null> {
    return this.runPhase(
      'isDone sync',
      this.isDoneSync,
      trigger,
      () => this.reconcileIsDone(),
      (r) =>
        `fetched=${r.fetchedDoneCount} marked=${r.markedDoneCount} reverted=${r.revertedCount} scanned=${r.totalScanned}`,
      /* crossPhaseGuard */ true,
    );
  }

  getIsDoneSyncStatus(): IsDoneSyncStatus {
    return ArchiveSyncService.toStatus(this.isDoneSync);
  }

  /**
   * Fetches a single page of done notices, retrying up to
   * {@link DONE_PAGE_MAX_RETRIES} times with linear backoff so a transient
   * HTTP timeout on page N does not abort the entire isDone sync.
   */
  private async fetchDonePageWithRetry(
    pageIndex: number,
  ): Promise<ISearchResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= DONE_PAGE_MAX_RETRIES; attempt++) {
      try {
        return await this.crawlingCoreService.searchDone({
          pageIndex,
          pageUnit: CRAWLER_PAGE_UNIT,
        });
      } catch (error) {
        lastError = error;
        if (attempt < DONE_PAGE_MAX_RETRIES) {
          const backoff = DONE_PAGE_RETRY_BASE_MS * (attempt + 1);
          LoggerUtils.warn(
            ArchiveSyncService.name,
            `isDone page ${pageIndex} failed ` +
              `(attempt ${attempt + 1}/${DONE_PAGE_MAX_RETRIES + 1}): ` +
              `${(error as Error).message} - retrying in ${backoff}ms`,
          );
          void this.discordBridge?.logEvent(
            BridgeLogLevel.WARN,
            ArchiveSyncService.name,
            `isDone page **${pageIndex}** failed (attempt ${attempt + 1}/${DONE_PAGE_MAX_RETRIES + 1}): ` +
              `${(error as Error).message} - retrying in ${backoff}ms`,
          );
          await new Promise<void>((resolve) => setTimeout(resolve, backoff));
        }
      }
    }
    throw lastError;
  }

  /**
   * Phase A - fetches all done pages with per-page retry, populates
   *            `doneNumSet`, eagerly marks matching archive rows as
   *            `isDone=true`.
   * Phase B - paginates `isDone=true` archive rows and reverts any whose
   *            noticeNum is absent from the fetched done-set.
   */
  private async reconcileIsDone(): Promise<IsDoneSyncResult> {
    LoggerUtils.logDev(
      ArchiveSyncService.name,
      'isDone reconciliation started',
    );

    // Phase A - manual page-by-page iteration with per-page retry
    // Using searchDone() instead of the streaming getAllDonePages() generator
    // so a timeout on page N can be retried in-place rather than restarting
    // the entire sync from page 1.
    const doneNumSet = new Set<number>();
    let markedDoneCount = 0;

    // Fetch page 1 first to learn totalPages, then iterate the rest.
    const firstPage = await this.fetchDonePageWithRetry(1);
    const totalPages = firstPage.totalPages;

    let pageNums = (firstPage.items ?? []).map((item) => item.num);
    for (const num of pageNums) doneNumSet.add(num);
    markedDoneCount +=
      await this.noticeArchiveService.markNoticesDoneByNums(pageNums);
    LoggerUtils.debugDev(
      ArchiveSyncService.name,
      `isDone page 1/${totalPages}: +${pageNums.length} nums, ${markedDoneCount} total marked`,
    );

    for (let pageIndex = 2; pageIndex <= totalPages; pageIndex++) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, CRAWLER_DELAY_MS),
      );
      const page = await this.fetchDonePageWithRetry(pageIndex);
      pageNums = (page.items ?? []).map((item) => item.num);
      for (const num of pageNums) doneNumSet.add(num);
      markedDoneCount +=
        await this.noticeArchiveService.markNoticesDoneByNums(pageNums);
      LoggerUtils.debugDev(
        ArchiveSyncService.name,
        `isDone page ${pageIndex}/${totalPages}: +${pageNums.length} nums, ${markedDoneCount} total marked`,
      );
    }

    if (doneNumSet.size === 0) {
      LoggerUtils.warn(
        ArchiveSyncService.name,
        'Crawler returned zero done notices - isDone reconciliation skipped',
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.WARN,
        ArchiveSyncService.name,
        'isDone sync: crawler returned **zero** done notices - reconciliation skipped',
      );
      return {
        fetchedDoneCount: 0,
        markedDoneCount: 0,
        revertedCount: 0,
        totalScanned: 0,
      };
    }

    // Phase B
    let totalScanned = 0;
    let revertedCount = 0;
    let skip = 0;

    for (;;) {
      const batch = await this.noticeArchiveService.getDoneMarkedNumsPage(
        skip,
        DONE_BATCH_SIZE,
      );
      if (batch.length === 0) break;

      totalScanned += batch.length;
      const toRevert = batch.filter((num) => !doneNumSet.has(num));
      if (toRevert.length > 0) {
        revertedCount +=
          await this.noticeArchiveService.revertNoticesDoneByNums(toRevert);
      }

      LoggerUtils.debugDev(
        ArchiveSyncService.name,
        `isDone Phase B [${skip}–${skip + batch.length - 1}]: ` +
          `scanned=${batch.length} reverted=${toRevert.length}`,
      );

      if (batch.length < DONE_BATCH_SIZE) break;
      skip += DONE_BATCH_SIZE;
    }

    LoggerUtils.log(
      ArchiveSyncService.name,
      `isDone reconciliation done - fetched=${doneNumSet.size} ` +
        `marked=${markedDoneCount} reverted=${revertedCount} scanned=${totalScanned}`,
    );
    if (revertedCount > 0) {
      void this.discordBridge?.logEvent(
        BridgeLogLevel.WARN,
        ArchiveSyncService.name,
        `isDone sync: reverted **${revertedCount}** stale done-flag(s) - ` +
          `fetched=${doneNumSet.size} marked=${markedDoneCount} scanned=${totalScanned}`,
      );
    } else {
      void this.discordBridge?.logEvent(
        BridgeLogLevel.LOG,
        ArchiveSyncService.name,
        `isDone sync complete - fetched=${doneNumSet.size} marked=${markedDoneCount} reverted=${revertedCount} scanned=${totalScanned}`,
      );
    }

    return {
      fetchedDoneCount: doneNumSet.size,
      markedDoneCount,
      revertedCount,
      totalScanned,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 3 – Integrity check
  // ─────────────────────────────────────────────────────────────────────────

  async runIntegrityCheck(
    trigger: string,
  ): Promise<IntegrityCheckResult | null> {
    return this.runPhase(
      'Integrity check',
      this.integrityCheck,
      trigger,
      () => this.noticeArchiveService.runIntegrityScan(INTEGRITY_BATCH_SIZE),
      (r) =>
        `scanned=${r.scanned} passed=${r.passed} failed=${r.failed} skipped=${r.skipped}`,
    );
  }

  /**
   * Scheduled full integrity re-validation pass.
   * @param trigger Describes what triggered the rescan (e.g. cron vs manual API call) for logging purposes.
   * @return Result summary, or `null` if a rescan is already in progress.
   */
  async runScheduledIntegrityRescan(
    trigger: string,
  ): Promise<IntegrityCheckResult | null> {
    const result = await this.runPhase(
      'Integrity rescan',
      this.integrityCheck,
      trigger,
      () =>
        this.noticeArchiveService.runIntegrityScan(
          INTEGRITY_BATCH_SIZE,
          /* forceUpdate */ true,
        ),
      (r) =>
        `scanned=${r.scanned} passed=${r.passed} failed=${r.failed} skipped=${r.skipped}`,
      /* crossPhaseGuard */ true,
    );

    if (result !== null && result.failed > 0) {
      void this.discordBridge?.logEvent(
        BridgeLogLevel.WARN,
        ArchiveSyncService.name,
        `[${trigger}] Integrity rescan detected **${result.failed}** fingerprint mismatch(es) - scanned=${result.scanned} passed=${result.passed} skipped=${result.skipped}`,
      );
    }

    return result;
  }

  getIntegrityCheckStatus(): IntegrityCheckStatus {
    return ArchiveSyncService.toStatus(this.integrityCheck);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 4 – Summary backfill
  // ─────────────────────────────────────────────────────────────────────────

  async runSummaryBackfill(
    trigger: string,
  ): Promise<SummaryBackfillResult | null> {
    return this.runPhase(
      'Summary backfill',
      this.summaryBackfill,
      trigger,
      () => this.executeSummaryBackfill(),
      (r) =>
        `scanned=${r.scanned} generated=${r.generated} skipped=${r.skipped} failed=${r.failed}`,
    );
  }

  getSummaryBackfillStatus(): SummaryBackfillStatus {
    return ArchiveSyncService.toStatus(this.summaryBackfill);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 5 – Unavailable summary retry
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Retries archive rows with `aiSummaryStatus = 'unavailable'` (e.g. rows
   * that failed during a previous backfill due to a transient Ollama outage).
   *
   * Unlike the backfill drain loop this uses **offset-based pagination** so
   * rows that remain `'unavailable'` after a failed retry do not cause an
   * infinite loop.
   *
   * Can be triggered manually via the admin API or runs automatically at the
   * end of the bootstrap pipeline (after the backfill phase).
   */
  async runUnavailableRetry(
    trigger: string,
  ): Promise<SummaryUnavailableRetryResult | null> {
    return this.runPhase(
      'Unavailable summary retry',
      this.unavailableRetry,
      trigger,
      () => this.executeUnavailableRetry(),
      (r) =>
        `scanned=${r.scanned} recovered=${r.recovered} skipped=${r.skipped} stillFailed=${r.stillFailed}`,
    );
  }

  getUnavailableRetryStatus(): SummaryUnavailableRetryStatus {
    return ArchiveSyncService.toStatus(this.unavailableRetry);
  }

  /**
   * Iterates all archive rows with `aiSummaryStatus = 'not_requested'` using
   * a drain loop (always skip=0) and generates summaries via Ollama.
   *
   * Each processed row is immediately updated so it leaves the pending set -
   * guaranteeing termination even when Ollama fails (rows transition to
   * `'unavailable'` rather than staying `'not_requested'`).
   *
   * Exits early without touching the DB when AI summary is disabled, to
   * prevent an infinite loop of no-op updates.
   */
  private async executeSummaryBackfill(): Promise<SummaryBackfillResult> {
    if (!this.summaryGenerationService.isAiSummaryEnabled()) {
      LoggerUtils.logDev(
        ArchiveSyncService.name,
        'Summary backfill skipped - AI summary disabled',
      );
      return { scanned: 0, generated: 0, skipped: 0, failed: 0 };
    }

    let scanned = 0;
    let generated = 0;
    let skipped = 0;
    let failed = 0;

    for (;;) {
      // Drain pattern: always fetch from offset 0.
      // Processed rows transition away from 'not_requested' and naturally
      // drop out of subsequent queries until the set is empty.
      const batch = await this.noticeArchiveService.getPendingSummaryPage(
        SUMMARY_BACKFILL_BATCH_SIZE,
      );
      if (batch.length === 0) break;

      const batchStatuses = await this.mapConcurrently(
        batch,
        SUMMARY_BACKFILL_CONCURRENCY,
        async (notice) => {
          try {
            const result =
              await this.summaryGenerationService.generateSummaryForNotice(
                notice,
                { phase: 'summary-backfill' },
              );
            await this.noticeArchiveService.updateSummaryStateByNoticeNum(
              notice.num,
              result.aiSummary,
              result.aiSummaryStatus,
            );
            return result.aiSummaryStatus;
          } catch (error) {
            LoggerUtils.error(
              ArchiveSyncService.name,
              `Summary backfill failed for notice ${notice.num}: ${(error as Error).message}`,
            );
            return 'unavailable' as const;
          }
        },
      );

      for (const status of batchStatuses) {
        if (status === 'ready') generated++;
        else if (status === 'not_supported') skipped++;
        else failed++; // 'unavailable'
      }

      scanned += batch.length;

      LoggerUtils.debugDev(
        ArchiveSyncService.name,
        `Summary backfill batch [${scanned - batch.length}–${scanned - 1}]: ` +
          `generated=${generated} skipped=${skipped} failed=${failed}`,
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.VERBOSE,
        ArchiveSyncService.name,
        `Summary backfill batch: scanned=${scanned} generated=${generated} skipped=${skipped} failed=${failed}`,
        { scanned, generated, skipped, failed },
      );

      if (batch.length < SUMMARY_BACKFILL_BATCH_SIZE) break;
    }

    LoggerUtils.log(
      ArchiveSyncService.name,
      `Summary backfill done - scanned=${scanned} generated=${generated} ` +
        `skipped=${skipped} failed=${failed}`,
    );

    return { scanned, generated, skipped, failed };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 5 – Unavailable summary retry (implementation)
  // ─────────────────────────────────────────────────────────────────────────

  private async executeUnavailableRetry(): Promise<SummaryUnavailableRetryResult> {
    if (!this.summaryGenerationService.isAiSummaryEnabled()) {
      LoggerUtils.logDev(
        ArchiveSyncService.name,
        'Unavailable summary retry skipped - AI summary disabled',
      );
      return { scanned: 0, recovered: 0, skipped: 0, stillFailed: 0 };
    }

    let scanned = 0;
    let recovered = 0;
    let skipped = 0;
    let stillFailed = 0;
    let skip = 0;

    for (;;) {
      // Offset-based pagination (NOT a drain loop).
      // Rows that remain 'unavailable' after retry stay in the set, so we
      // must advance skip to avoid an infinite loop.
      const batch = await this.noticeArchiveService.getUnavailableSummaryPage(
        skip,
        SUMMARY_BACKFILL_BATCH_SIZE,
      );
      if (batch.length === 0) break;

      const batchStatuses = await this.mapConcurrently(
        batch,
        SUMMARY_BACKFILL_CONCURRENCY,
        async (notice) => {
          try {
            const result =
              await this.summaryGenerationService.generateSummaryForNotice(
                notice,
                { phase: 'unavailable-retry' },
              );
            await this.noticeArchiveService.updateSummaryStateByNoticeNum(
              notice.num,
              result.aiSummary,
              result.aiSummaryStatus,
            );
            return result.aiSummaryStatus;
          } catch (error) {
            LoggerUtils.error(
              ArchiveSyncService.name,
              `Unavailable retry failed for notice ${notice.num}: ${(error as Error).message}`,
            );
            return 'unavailable' as const;
          }
        },
      );

      for (const status of batchStatuses) {
        if (status === 'ready') recovered++;
        else if (status === 'not_supported') skipped++;
        else stillFailed++; // 'unavailable'
      }

      scanned += batch.length;

      LoggerUtils.debugDev(
        ArchiveSyncService.name,
        `Unavailable retry batch [${skip}–${skip + batch.length - 1}]: ` +
          `recovered=${recovered} skipped=${skipped} stillFailed=${stillFailed}`,
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.VERBOSE,
        ArchiveSyncService.name,
        `Unavailable retry batch: scanned=${scanned} recovered=${recovered} skipped=${skipped} stillFailed=${stillFailed}`,
        { scanned, recovered, skipped, stillFailed },
      );

      if (batch.length < SUMMARY_BACKFILL_BATCH_SIZE) break;
      skip += SUMMARY_BACKFILL_BATCH_SIZE;
    }

    LoggerUtils.log(
      ArchiveSyncService.name,
      `Unavailable summary retry done - scanned=${scanned} recovered=${recovered} ` +
        `skipped=${skipped} stillFailed=${stillFailed}`,
    );

    return { scanned, recovered, skipped, stillFailed };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Maps `items` through `mapper` with at most `concurrency` parallel calls.
   * Preserves input order in the returned array.
   */
  private async mapConcurrently<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) return [];
    const limit = Math.max(1, concurrency);
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const worker = async () => {
      for (;;) {
        const idx = nextIndex++;
        if (idx >= items.length) return;
        results[idx] = await mapper(items[idx]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, worker),
    );
    return results;
  }
}
