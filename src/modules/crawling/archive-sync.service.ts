import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import {
  type ITableData,
  type INsmBillItem,
  type ISearchResult,
} from 'pal-crawl';
import { APP_CONSTANTS } from '../../config/app.config';
import { CrawlingCoreService } from './crawling-core.service';
import { NoticeArchiveService } from '../notice/notice-archive.service';
import { ArchiveOrchestratorService } from './archive-orchestrator.service';
import { SummaryGenerationService } from './summary-generation.service';
import { CacheService } from '../cache/cache.service';
import { DiscordBridgeService } from '../discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../discord-bridge/discord-bridge.types';
import { LoggerUtils } from '../../utils/logger.utils';
import { mapConcurrently } from '../../utils/concurrency.utils';
import { type CachedNotice } from '../../types/cache.types';
import { AI_SUMMARY_STATUS } from './utils/ai-summary-status.utils';
import { type LegacyGenesisSeedResult } from '../notice/notice-archive.service';
import {
  ArchiveSyncPhaseRunner,
  type ArchiveSyncPhaseState,
  type ArchiveSyncPhaseStatus,
  makePhaseTracker,
  type PhaseEntry,
  type PhaseTracker,
} from './utils/archive-sync-phase-runner';

// ─── Tuning constants (sourced from APP_CONSTANTS.ARCHIVE_SYNC) ───────────────

const {
  CRAWLER_PAGE_UNIT,
  CRAWLER_DELAY_MS,
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
const DONE_PAGE_RETRY_BASE_MS = 1000;

// ─── Public types ─────────────────────────────────────────────────────────────

export type SyncPhaseStatus = ArchiveSyncPhaseStatus;

/**
 * Generic status snapshot returned by each `getXxxStatus()` accessor.
 * All three sync phases share the same shape - only the result type differs.
 */
export type PhaseStatus<TResult> = ArchiveSyncPhaseState<TResult>;

export interface FullSyncResult {
  totalPagesScanned: number;
  totalNoticesScanned: number;
  newlyArchivedCount: number;
}

export interface IsDoneSyncResult {
  fetchedDoneCount: number;
  markedDoneCount: number;
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

/** Result of a single NsmLmSts pending-bills sync pass. */
export interface PendingSyncResult {
  totalScanned: number;
  newlyArchivedCount: number;
}

export type FullSyncStatus = PhaseStatus<FullSyncResult>;
export type IsDoneSyncStatus = PhaseStatus<IsDoneSyncResult>;
export type IntegrityCheckStatus = PhaseStatus<IntegrityCheckResult>;
export type SummaryBackfillStatus = PhaseStatus<SummaryBackfillResult>;
export type SummaryUnavailableRetryStatus =
  PhaseStatus<SummaryUnavailableRetryResult>;
export type PendingSyncStatus = PhaseStatus<PendingSyncResult>;
export type LegacyGenesisSeedStatus = PhaseStatus<LegacyGenesisSeedResult>;

export interface ArchiveSyncExecutionState {
  isAnyPhaseRunning: boolean;
  runningPhases: string[];
  phases: Array<{
    name: string;
    status: SyncPhaseStatus;
    lastRunAt: string | null;
    lastError: string | null;
  }>;
}

// ─── Internal tracker ─────────────────────────────────────────────────────────

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

  private readonly phaseRunner = new ArchiveSyncPhaseRunner();

  private readonly fullSync = makePhaseTracker<FullSyncResult>();
  private readonly isDoneSync = makePhaseTracker<IsDoneSyncResult>();
  private readonly integrityCheck = makePhaseTracker<IntegrityCheckResult>();
  private readonly summaryBackfill = makePhaseTracker<SummaryBackfillResult>();
  private readonly unavailableRetry =
    makePhaseTracker<SummaryUnavailableRetryResult>();
  private readonly pendingSync = makePhaseTracker<PendingSyncResult>();
  private readonly legacyGenesisSeed =
    makePhaseTracker<LegacyGenesisSeedResult>();

  constructor(
    private readonly crawlingCoreService: CrawlingCoreService,
    private readonly noticeArchiveService: NoticeArchiveService,
    private readonly archiveOrchestratorService: ArchiveOrchestratorService,
    private readonly summaryGenerationService: SummaryGenerationService,
    private readonly cacheService: CacheService,
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
    const bootstrapBoundaryAt = new Date();

    this.noticeArchiveService.beginChangeNotificationSuppression?.();

    try {
      await this.safeRun('pending sync', () =>
        this.runPendingSync('bootstrap'),
      );
      await this.safeRun('legacy genesis seed', () =>
        this.runLegacyGenesisSeed('bootstrap', bootstrapBoundaryAt),
      );
      await this.safeRun('full sync', () => this.runFullSync('bootstrap'));
      await this.safeRun('summary backfill', () =>
        this.runSummaryBackfill('bootstrap'),
      );
      await this.safeRun('unavailable retry', () =>
        this.runUnavailableRetry('bootstrap'),
      );
      await this.safeRun('isDone sync', () => this.runIsDoneSync('bootstrap'));
      await this.safeRun('integrity check', () =>
        this.runIntegrityCheck('bootstrap'),
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
    } finally {
      this.noticeArchiveService.endChangeNotificationSuppression?.();
    }
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
    return this.phaseRunner.isAnyPhaseRunning(this.getPhaseEntries());
  }

  /**
   * Waits until all archive-sync phases are idle.
   * Throws when timeout is exceeded.
   */
  async waitForIdle(timeoutMs = 10000, pollMs = 200): Promise<void> {
    const startedAt = Date.now();

    while (this.isAnyPhaseRunning()) {
      if (Date.now() - startedAt >= timeoutMs) {
        const running =
          this.getExecutionState().runningPhases.join(', ') || '-';
        throw new Error(
          `archive sync still running after ${timeoutMs}ms (runningPhases=${running})`,
        );
      }

      await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /**
   * Returns a full execution snapshot for lock/phase debugging.
   */
  getExecutionState(): ArchiveSyncExecutionState {
    const entries = this.getPhaseEntries();
    const runningPhases = entries
      .filter(({ tracker }) => tracker.isRunning)
      .map(({ name }) => name);

    return {
      isAnyPhaseRunning: runningPhases.length > 0,
      runningPhases,
      phases: entries.map(({ name, tracker }) => ({
        name,
        status: tracker.status,
        lastRunAt: tracker.lastRunAt,
        lastError: tracker.lastError,
      })),
    };
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
    return this.phaseRunner.runPhase({
      phaseName,
      tracker,
      trigger,
      task,
      formatResult,
      crossPhaseGuard,
      phaseEntries: this.getPhaseEntries(),
      serviceName: ArchiveSyncService.name,
      discordLogger: (level, serviceName, message) => {
        void this.discordBridge?.logEvent(level, serviceName, message);
      },
    });
  }

  /** Returns a status snapshot without the internal `isRunning` flag. */
  private toStatus<T>(tracker: PhaseTracker<T>): PhaseStatus<T> {
    return this.phaseRunner.toStatus(tracker);
  }

  private getPhaseEntries(): PhaseEntry[] {
    return [
      { name: 'full sync', tracker: this.fullSync },
      { name: 'isDone sync', tracker: this.isDoneSync },
      { name: 'integrity check', tracker: this.integrityCheck },
      { name: 'summary backfill', tracker: this.summaryBackfill },
      { name: 'unavailable retry', tracker: this.unavailableRetry },
      { name: 'pending sync', tracker: this.pendingSync },
      { name: 'legacy genesis seed', tracker: this.legacyGenesisSeed },
    ];
  }

  async runLegacyGenesisSeed(
    trigger: string,
    boundaryAt = new Date(),
  ): Promise<LegacyGenesisSeedResult | null> {
    return this.runPhase(
      'Legacy genesis seed',
      this.legacyGenesisSeed,
      trigger,
      () => this.noticeArchiveService.seedLegacyGenesisEvents(boundaryAt),
      (r) =>
        `boundary=${r.boundaryAt} scanned=${r.scanned} seeded=${r.seeded} skipped=${r.skipped}`,
      /* crossPhaseGuard */ true,
    );
  }

  getLegacyGenesisSeedStatus(): LegacyGenesisSeedStatus {
    return this.toStatus(this.legacyGenesisSeed);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 1 - Full archive sync
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
    return this.toStatus(this.fullSync);
  }

  private async executeFullSync(): Promise<FullSyncResult> {
    LoggerUtils.log(ArchiveSyncService.name, 'Full archive sync started');

    let totalPagesScanned = 0;
    let totalNoticesScanned = 0;
    let newlyArchivedCount = 0;
    const seenPalActiveNums = new Set<number>();

    this.noticeArchiveService.beginChangeNotificationCollection();

    try {
      for await (const page of this.crawlingCoreService.getAllPages(
        { pageUnit: CRAWLER_PAGE_UNIT },
        { delayMs: CRAWLER_DELAY_MS, concurrency: 1 },
      )) {
        totalPagesScanned++;
        // Guard against unexpected null/undefined items from the crawler
        const pageItems: ITableData[] = page.items ?? [];
        for (const item of pageItems) {
          seenPalActiveNums.add(item.num);
        }
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
            { reason: 'full-sync-new-notices' },
          );
          newlyArchivedCount += saved;
        }

        // Upgrade pending bills: bills previously archived from NsmLmSts with
        // contentId=NULL that now appear in pal.assembly.go.kr with a contentId.
        const newNums = new Set(newNotices.map((n) => n.num));
        const alreadyArchivedWithContentId = pageItems.filter(
          (item) => !newNums.has(item.num) && item.contentId !== null,
        );
        if (alreadyArchivedWithContentId.length > 0) {
          const nullContentIdNums =
            await this.noticeArchiveService.getArchivedNullContentIdNums(
              alreadyArchivedWithContentId.map((i) => i.num),
            );
          if (nullContentIdNums.size > 0) {
            const toUpgrade = alreadyArchivedWithContentId.filter((item) =>
              nullContentIdNums.has(item.num),
            );

            // Re-archive with PAL source/detail so NSM-first rows are naturally
            // refreshed (proposal metadata/source HTML/etc.) once PAL publishes.
            // Do not pass aiSummary/aiSummaryStatus here: this path updates
            // archive metadata only and must not mutate existing summary states.
            const upgraded =
              await this.archiveOrchestratorService.archiveNotices(
                toUpgrade.map((item) => ({
                  num: item.num,
                  subject: item.subject,
                  proposerCategory: item.proposerCategory,
                  committee: item.committee,
                  link: item.link,
                  contentId: item.contentId,
                  attachments: item.attachments ?? {
                    pdfFile: null,
                    hwpFile: null,
                  },
                })),
                { reason: 'nsm-pal-upgrade' },
              );
            if (upgraded > 0) {
              LoggerUtils.logDev(
                ArchiveSyncService.name,
                `Upgraded ${upgraded} pending bill(s) from NSM to PAL with full archive refresh`,
              );
              void this.discordBridge?.logEvent(
                BridgeLogLevel.DEBUG,
                ArchiveSyncService.name,
                `NSM->PAL archive refresh applied: upgraded **${upgraded}** bill(s) on full sync`,
                {
                  upgraded,
                  detected: toUpgrade.length,
                  sampleNoticeNums: toUpgrade
                    .slice(0, 10)
                    .map((item) => item.num),
                },
              );
            }
          }
        }

        LoggerUtils.debugDev(
          ArchiveSyncService.name,
          `Page ${page.currentPage}/${page.totalPages}: ` +
            `total=${pageItems.length} new=${newNotices.length}`,
        );
      }

      const sourceDeletedCount =
        await this.noticeArchiveService.markSourceDeletedByMissingPalNums(
          seenPalActiveNums,
        );
      if (sourceDeletedCount > 0) {
        LoggerUtils.log(
          ArchiveSyncService.name,
          `Marked ${sourceDeletedCount} notice(s) as source_deleted after PAL full sync reconciliation`,
        );
      }

      return { totalPagesScanned, totalNoticesScanned, newlyArchivedCount };
    } finally {
      await this.noticeArchiveService.endChangeNotificationCollection();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 1b - Pending bills sync (NsmLmSts)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Archives bills that are in \"\ubc1c\uc758\" (proposed) state at \uad6d\ubbfc\ucc38\uc5ec\uc785\ubc95\uc13c\ud130
   * (opinion.lawmaking.go.kr) before they enter the formal \uc785\ubc95\uc608\uace0 process.
   *
   * This phase runs before the full pal.assembly.go.kr sync so the system
   * detects new bills at the earliest possible point in the legislative cycle.
   */
  async runPendingSync(trigger: string): Promise<PendingSyncResult | null> {
    return this.runPhase(
      'Pending sync',
      this.pendingSync,
      trigger,
      () => this.executePendingSync(),
      (r) => `scanned=${r.totalScanned} archived=${r.newlyArchivedCount}`,
    );
  }

  getPendingSyncStatus(): PendingSyncStatus {
    return this.toStatus(this.pendingSync);
  }

  private async executePendingSync(): Promise<PendingSyncResult> {
    LoggerUtils.logDev(
      ArchiveSyncService.name,
      'Pending bills sync (NsmLmSts) started',
    );

    this.noticeArchiveService.beginChangeNotificationCollection();

    try {
      const rawItemMap = new Map<number, INsmBillItem>();
      const pendingNotices: ReturnType<
        typeof CrawlingCoreService.nsmBillToCachedNotice
      >[] = [];

      for await (const page of this.crawlingCoreService.getAllNsmPendingPages(
        {},
        { delayMs: CRAWLER_DELAY_MS, concurrency: 1 },
      )) {
        for (const item of page.items ?? []) {
          const notice = CrawlingCoreService.nsmBillToCachedNotice(item);
          if (!rawItemMap.has(notice.num)) {
            rawItemMap.set(notice.num, item);
            pendingNotices.push(notice);
          }
        }
      }

      const totalScanned = pendingNotices.length;

      if (totalScanned === 0) {
        LoggerUtils.logDev(
          ArchiveSyncService.name,
          'No pending bills found in NsmLmSts',
        );
        return { totalScanned: 0, newlyArchivedCount: 0 };
      }

      const newPendingNotices =
        await this.archiveOrchestratorService.filterAlreadyArchivedNotices(
          pendingNotices,
        );

      let newlyArchivedCount = 0;
      if (newPendingNotices.length > 0) {
        const newPendingItems = newPendingNotices
          .map((n) => rawItemMap.get(n.num))
          .filter((item): item is INsmBillItem => item !== undefined);
        const archived =
          await this.archiveOrchestratorService.archiveNsmBillItems(
            newPendingItems,
            { reason: 'new-pending-bills' },
          );
        newlyArchivedCount = archived.length;
      }

      LoggerUtils.log(
        ArchiveSyncService.name,
        `Pending sync done - scanned=${totalScanned} new=${newPendingNotices.length} archived=${newlyArchivedCount}`,
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.LOG,
        ArchiveSyncService.name,
        `Pending sync complete - scanned=${totalScanned} new=${newPendingNotices.length} archived=${newlyArchivedCount}`,
      );

      return { totalScanned, newlyArchivedCount };
    } finally {
      await this.noticeArchiveService.endChangeNotificationCollection();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 2 - isDone sync
  // ─────────────────────────────────────────────────────────────────────────

  async runIsDoneSync(trigger: string): Promise<IsDoneSyncResult | null> {
    return this.runPhase(
      'isDone sync',
      this.isDoneSync,
      trigger,
      () => this.reconcileIsDone(),
      (r) => `fetched=${r.fetchedDoneCount} marked=${r.markedDoneCount}`,
      /* crossPhaseGuard */ true,
    );
  }

  getIsDoneSyncStatus(): IsDoneSyncStatus {
    return this.toStatus(this.isDoneSync);
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
    LoggerUtils.log(ArchiveSyncService.name, 'isDone reconciliation started');

    // Iterates all done-notice pages and marks matching archive rows as
    // isDone=true. Marks are never reverted - once done, always done.
    let markedDoneCount = 0;
    let fetchedDoneCount = 0;

    // Fetch page 1 first to learn totalPages, then iterate the rest.
    const firstPage = await this.fetchDonePageWithRetry(1);
    const totalPages = firstPage.totalPages;

    let pageNums = (firstPage.items ?? []).map((item) => item.num);
    fetchedDoneCount += pageNums.length;
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
      fetchedDoneCount += pageNums.length;
      markedDoneCount +=
        await this.noticeArchiveService.markNoticesDoneByNums(pageNums);
      LoggerUtils.debugDev(
        ArchiveSyncService.name,
        `isDone page ${pageIndex}/${totalPages}: +${pageNums.length} nums, ${markedDoneCount} total marked`,
      );
    }

    LoggerUtils.log(
      ArchiveSyncService.name,
      `isDone reconciliation done - fetched=${fetchedDoneCount} marked=${markedDoneCount}`,
    );
    void this.discordBridge?.logEvent(
      BridgeLogLevel.LOG,
      ArchiveSyncService.name,
      `isDone sync complete - fetched=${fetchedDoneCount} marked=${markedDoneCount}`,
    );

    return { fetchedDoneCount, markedDoneCount };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 3 - Integrity check
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
      () => this.noticeArchiveService.runIntegrityScan(INTEGRITY_BATCH_SIZE),
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
    return this.toStatus(this.integrityCheck);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 4 - Summary backfill
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
    return this.toStatus(this.summaryBackfill);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 5 - Unavailable summary retry
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
    return this.toStatus(this.unavailableRetry);
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

      const batchCacheUpdates: CachedNotice[] = [];
      const batchStatuses = await mapConcurrently(
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
            batchCacheUpdates.push({
              ...notice,
              aiSummary: result.aiSummary,
              aiSummaryStatus: result.aiSummaryStatus,
            });
            return result.aiSummaryStatus;
          } catch (error) {
            LoggerUtils.error(
              ArchiveSyncService.name,
              `Summary backfill failed for notice ${notice.num}: ${(error as Error).message}`,
            );

            await this.noticeArchiveService
              .updateSummaryStateByNoticeNum(
                notice.num,
                null,
                AI_SUMMARY_STATUS.UNAVAILABLE,
              )
              .catch((persistError) => {
                LoggerUtils.warn(
                  ArchiveSyncService.name,
                  `Failed to persist unavailable summary state for notice ${notice.num}: ${(persistError as Error).message}`,
                );
              });

            batchCacheUpdates.push({
              ...notice,
              aiSummary: null,
              aiSummaryStatus: AI_SUMMARY_STATUS.UNAVAILABLE,
            });

            return AI_SUMMARY_STATUS.UNAVAILABLE;
          }
        },
      );

      // Reflect the backfill results in the Redis cache immediately so the
      // API response shows the freshly-generated summaries without waiting
      // for the next crawl cycle or a backend restart.
      if (batchCacheUpdates.length > 0) {
        await this.cacheService.updateCache(batchCacheUpdates);
      }

      for (const status of batchStatuses) {
        if (status === 'ready') generated++;
        else if (status === 'not_supported') skipped++;
        else failed++; // 'unavailable'
      }

      scanned += batch.length;

      LoggerUtils.debugDev(
        ArchiveSyncService.name,
        `Summary backfill batch [${scanned - batch.length}-${scanned - 1}]: ` +
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
  // Phase 5 - Unavailable summary retry (implementation)
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

      const batchCacheUpdates: CachedNotice[] = [];
      const batchStatuses = await mapConcurrently(
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
            batchCacheUpdates.push({
              ...notice,
              aiSummary: result.aiSummary,
              aiSummaryStatus: result.aiSummaryStatus,
            });
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

      // Reflect the retry results in the Redis cache immediately so the
      // API response shows recovered summaries without waiting for the
      // next crawl cycle or a backend restart.
      if (batchCacheUpdates.length > 0) {
        await this.cacheService.updateCache(batchCacheUpdates);
      }

      for (const status of batchStatuses) {
        if (status === 'ready') recovered++;
        else if (status === 'not_supported') skipped++;
        else stillFailed++; // 'unavailable'
      }

      scanned += batch.length;

      LoggerUtils.debugDev(
        ArchiveSyncService.name,
        `Unavailable retry batch [${skip}-${skip + batch.length - 1}]: ` +
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
}
