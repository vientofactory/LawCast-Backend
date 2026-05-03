import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { CrawlingCoreService } from './crawling-core.service';
import { NoticeArchiveService } from './notice-archive.service';
import { DiscordBridgeService } from '../modules/discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../modules/discord-bridge/discord-bridge.types';
import { LoggerUtils } from '../utils/logger.utils';

/** DB rows fetched per revert-pass batch. Larger = fewer round-trips, more memory. */
const BATCH_SIZE = 500;
/** Items per crawler HTTP request. 100 is the maximum the PAL Assembly endpoint accepts. */
const CRAWLER_PAGE_UNIT = 100;
/** Inter-page delay forwarded to the crawler's pagination helper (ms). */
const CRAWLER_DELAY_MS = 500;

export interface IsDoneSyncResult {
  fetchedDoneCount: number;
  markedDoneCount: number;
  revertedCount: number;
  totalScanned: number;
}

export type IsDoneSyncStatusKind = 'idle' | 'running' | 'failed';

export interface IsDoneSyncStatus {
  status: IsDoneSyncStatusKind;
  lastRunAt: string | null;
  lastResult: IsDoneSyncResult | null;
  lastError: string | null;
}

interface FetchAndMarkResult {
  doneNumSet: Set<number>;
  markedDoneCount: number;
}

interface RevertPassResult {
  revertedCount: number;
  totalScanned: number;
}

@Injectable()
export class IsDoneSyncService implements OnModuleInit {
  private isSyncing = false;
  private lastStatus: IsDoneSyncStatus = {
    status: 'idle',
    lastRunAt: null,
    lastResult: null,
    lastError: null,
  };

  constructor(
    private readonly crawlingCoreService: CrawlingCoreService,
    private readonly noticeArchiveService: NoticeArchiveService,
    @Optional() private readonly discordBridge: DiscordBridgeService,
  ) {}

  /**
   * Fires an initial sync in the background immediately after the module
   * has finished initializing, so the DB reflects up-to-date isDone state
   * before the first scheduled cron tick.
   */
  onModuleInit(): void {
    LoggerUtils.logDev(
      IsDoneSyncService.name,
      'Scheduling initial isDone sync in background...',
    );
    void this.runSync('bootstrap');
  }

  /**
   * Returns a snapshot of the current sync state for metrics/status endpoints.
   * The returned object is immutable - callers must not mutate it.
   */
  getSyncStatus(): IsDoneSyncStatus {
    return { ...this.lastStatus };
  }

  /**
   * Acquires the in-progress guard, delegates to the full reconciliation,
   * then reports the outcome to Discord. Returns null if already syncing.
   *
   * @param trigger - Label used in log output to identify the caller.
   */
  async runSync(trigger: string): Promise<IsDoneSyncResult | null> {
    if (this.isSyncing) {
      LoggerUtils.warn(
        IsDoneSyncService.name,
        `isDone sync already in progress - skipping [${trigger}]`,
      );
      return null;
    }

    this.isSyncing = true;
    this.lastStatus = {
      ...this.lastStatus,
      status: 'running',
      lastError: null,
    };

    try {
      const result = await this.reconcile();
      this.lastStatus = {
        status: 'idle',
        lastRunAt: new Date().toISOString(),
        lastResult: result,
        lastError: null,
      };
      void this.discordBridge?.logEvent(
        BridgeLogLevel.DEBUG,
        IsDoneSyncService.name,
        `[${trigger}] fetched=${result.fetchedDoneCount} ` +
          `marked=${result.markedDoneCount} ` +
          `reverted=${result.revertedCount} ` +
          `scanned=${result.totalScanned}`,
      );
      return result;
    } catch (error) {
      this.lastStatus = {
        ...this.lastStatus,
        status: 'failed',
        lastRunAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      };
      throw error;
    } finally {
      this.isSyncing = false;
    }
  }

  // ── Orchestration ───────────────────────────────────────────────────────────

  /**
   * Coordinates the two-phase isDone reconciliation and assembles the
   * final result. Delegates each phase to a focused private method.
   */
  private async reconcile(): Promise<IsDoneSyncResult> {
    LoggerUtils.logDev(IsDoneSyncService.name, 'isDone reconciliation started');

    const { doneNumSet, markedDoneCount } = await this.fetchAndMarkDonePages();

    if (doneNumSet.size === 0) {
      LoggerUtils.warn(
        IsDoneSyncService.name,
        'Crawler returned zero done notices - reconciliation skipped',
      );
      return {
        fetchedDoneCount: 0,
        markedDoneCount: 0,
        revertedCount: 0,
        totalScanned: 0,
      };
    }

    const { revertedCount, totalScanned } =
      await this.revertStaleDoneRows(doneNumSet);

    LoggerUtils.log(
      IsDoneSyncService.name,
      `isDone reconciliation done - ` +
        `fetched=${doneNumSet.size} marked=${markedDoneCount} ` +
        `reverted=${revertedCount} scanned=${totalScanned}`,
    );

    return {
      fetchedDoneCount: doneNumSet.size,
      markedDoneCount,
      revertedCount,
      totalScanned,
    };
  }

  // ── Phase 1: fetch + eager mark ─────────────────────────────────────────────

  /**
   * Streams all done-notice pages from the crawler. For each page that
   * arrives, `isDone` is immediately set to true in the DB for that page's
   * notice nums - overlapping DB writes with the crawler's inter-page delay.
   *
   * Safe to mark eagerly: `isDone false→true` is fully determined the moment
   * a num appears on any crawler page.
   */
  private async fetchAndMarkDonePages(): Promise<FetchAndMarkResult> {
    const doneNumSet = new Set<number>();
    let markedDoneCount = 0;

    for await (const page of this.crawlingCoreService.getAllDonePages(
      { pageUnit: CRAWLER_PAGE_UNIT },
      { delayMs: CRAWLER_DELAY_MS, concurrency: 1 },
    )) {
      const pageNums = page.items.map((item) => item.num);
      for (const num of pageNums) doneNumSet.add(num);

      const marked =
        await this.noticeArchiveService.markNoticesDoneByNums(pageNums);
      markedDoneCount += marked;

      LoggerUtils.debugDev(
        IsDoneSyncService.name,
        `Page ${page.currentPage}/${page.totalPages}: ` +
          `+${page.items.length} nums, ${marked} newly marked`,
      );
    }

    LoggerUtils.logDev(
      IsDoneSyncService.name,
      `Phase 1 complete - ${doneNumSet.size} done num(s) fetched, ${markedDoneCount} marked`,
    );

    return { doneNumSet, markedDoneCount };
  }

  // ── Phase 2: revert pass ─────────────────────────────────────────────────────

  /**
   * Paginates only the `isDone=true` archive rows and reverts each one
   * whose noticeNum is absent from `doneNumSet`.
   *
   * By querying only already-marked rows we skip the entire `isDone=false`
   * population, so each record independently qualifies itself - no full-table
   * scan needed.
   *
   * Must run after Phase 1: a row is safe to revert only after the complete
   * doneNumSet is known.
   */
  private async revertStaleDoneRows(
    doneNumSet: Set<number>,
  ): Promise<RevertPassResult> {
    let totalScanned = 0;
    let revertedCount = 0;
    let skip = 0;

    for (;;) {
      const batch = await this.noticeArchiveService.getDoneMarkedNumsPage(
        skip,
        BATCH_SIZE,
      );
      if (batch.length === 0) break;

      totalScanned += batch.length;

      const toRevert = batch.filter((num) => !doneNumSet.has(num));

      if (toRevert.length > 0) {
        revertedCount +=
          await this.noticeArchiveService.revertNoticesDoneByNums(toRevert);
      }

      LoggerUtils.debugDev(
        IsDoneSyncService.name,
        `Phase 2 [${skip}-${skip + batch.length - 1}]: ` +
          `scanned=${batch.length} reverted=${toRevert.length}`,
      );

      if (batch.length < BATCH_SIZE) break;
      skip += BATCH_SIZE;
    }

    LoggerUtils.logDev(
      IsDoneSyncService.name,
      `Phase 2 complete - scanned=${totalScanned} reverted=${revertedCount}`,
    );

    return { revertedCount, totalScanned };
  }
}
