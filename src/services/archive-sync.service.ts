import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { type ITableData } from 'pal-crawl';
import { CrawlingCoreService } from './crawling-core.service';
import { NoticeArchiveService } from './notice-archive.service';
import { ArchiveOrchestratorService } from './archive-orchestrator.service';
import { SummaryGenerationService } from './summary-generation.service';
import { DiscordBridgeService } from '../modules/discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../modules/discord-bridge/discord-bridge.types';
import { LoggerUtils } from '../utils/logger.utils';

// ─── Tuning constants ─────────────────────────────────────────────────────────

/** Items per crawler HTTP request (max 100). */
const CRAWLER_PAGE_UNIT = 100;
/** Inter-page delay forwarded to pal-crawl (ms). */
const CRAWLER_DELAY_MS = 500;
/** DB rows fetched per revert-pass batch. */
const DONE_BATCH_SIZE = 500;
/** Archive rows per integrity-scan batch. */
const INTEGRITY_BATCH_SIZE = 200;
/** Archive rows fetched per summary-backfill batch. */
const SUMMARY_BACKFILL_BATCH_SIZE = 50;

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

export type FullSyncStatus = PhaseStatus<FullSyncResult>;
export type IsDoneSyncStatus = PhaseStatus<IsDoneSyncResult>;
export type IntegrityCheckStatus = PhaseStatus<IntegrityCheckResult>;
export type SummaryBackfillStatus = PhaseStatus<SummaryBackfillResult>;

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
   * Guards against concurrent runs, tracks phase state, fires a Discord log
   * on success, and re-throws on failure after setting `status='failed'`.
   *
   * @returns `null` if the phase is already running, otherwise the task result.
   */
  private async runPhase<T>(
    phaseName: string,
    tracker: PhaseTracker<T>,
    trigger: string,
    task: () => Promise<T>,
    formatResult?: (result: T) => string,
  ): Promise<T | null> {
    if (tracker.isRunning) {
      LoggerUtils.warn(
        ArchiveSyncService.name,
        `${phaseName} already in progress - skipping [${trigger}]`,
      );
      return null;
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
      totalNoticesScanned += page.items.length;

      const newNotices =
        await this.archiveOrchestratorService.filterAlreadyArchivedNotices(
          page.items as ITableData[],
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
          `total=${page.items.length} new=${newNotices.length}`,
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
    );
  }

  getIsDoneSyncStatus(): IsDoneSyncStatus {
    return ArchiveSyncService.toStatus(this.isDoneSync);
  }

  /**
   * Phase A - streams all done pages, populates `doneNumSet`, eagerly marks
   *            matching archive rows as `isDone=true`.
   * Phase B - paginates `isDone=true` archive rows and reverts any whose
   *            noticeNum is absent from the fetched done-set.
   */
  private async reconcileIsDone(): Promise<IsDoneSyncResult> {
    LoggerUtils.logDev(
      ArchiveSyncService.name,
      'isDone reconciliation started',
    );

    // Phase A
    const doneNumSet = new Set<number>();
    let markedDoneCount = 0;

    for await (const page of this.crawlingCoreService.getAllDonePages(
      { pageUnit: CRAWLER_PAGE_UNIT },
      { delayMs: CRAWLER_DELAY_MS, concurrency: 1 },
    )) {
      const pageNums = page.items.map((item) => item.num);
      for (const num of pageNums) doneNumSet.add(num);
      markedDoneCount +=
        await this.noticeArchiveService.markNoticesDoneByNums(pageNums);

      LoggerUtils.debugDev(
        ArchiveSyncService.name,
        `isDone page ${page.currentPage}/${page.totalPages}: ` +
          `+${page.items.length} nums, ${markedDoneCount} total marked`,
      );
    }

    if (doneNumSet.size === 0) {
      LoggerUtils.warn(
        ArchiveSyncService.name,
        'Crawler returned zero done notices - isDone reconciliation skipped',
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

      for (const notice of batch) {
        const result =
          await this.summaryGenerationService.generateSummaryForNotice(notice, {
            phase: 'summary-backfill',
          });

        await this.noticeArchiveService.updateSummaryStateByNoticeNum(
          notice.num,
          result.aiSummary,
          result.aiSummaryStatus,
        );

        if (result.aiSummaryStatus === 'ready') generated++;
        else if (result.aiSummaryStatus === 'not_supported') skipped++;
        else failed++; // 'unavailable'
      }

      scanned += batch.length;

      LoggerUtils.debugDev(
        ArchiveSyncService.name,
        `Summary backfill batch [${scanned - batch.length}–${scanned - 1}]: ` +
          `generated=${generated} skipped=${skipped} failed=${failed}`,
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
}
