import {
  type INsmBillItem,
  type ISearchResult,
  type ITableData,
} from 'pal-crawl';
import { AISummaryStatus, type CachedNotice } from '../../../types/cache.types';
import { APP_CONSTANTS } from '../../../config/app.config';
import { BridgeLogLevel } from '../../discord-bridge/discord-bridge.types';
import { LoggerUtils } from '../../../utils/logger.utils';
import { mapConcurrently } from '../../../utils/concurrency.utils';
import { type DiscordBridgeService } from '../../discord-bridge/discord-bridge.service';
import {
  ArchiveReason,
  NsmArchiveReason,
  type ArchiveOrchestratorService,
} from '../archive-orchestrator.service';
import { type CacheService } from '../../cache/cache.service';
import { CrawlingCoreService } from '../crawling-core.service';
import { type NoticeArchiveService } from '../../notice/notice-archive.service';
import { type SummaryGenerationService } from '../summary-generation.service';
import { type ChangeTrackingService } from '../../change-tracking/change-tracking.service';
import { type FullSyncResult } from '../archive-sync.service';
import { type IsDoneSyncResult } from '../archive-sync.service';
import { type ChainIntegrityAuditResult } from '../archive-sync.service';
import { type PendingSyncResult } from '../archive-sync.service';
import { type SummaryBackfillResult } from '../archive-sync.service';
import { delayMs } from '../../../utils/async-delay.utils';
import { logAndBridge } from '../../../utils/bridge-log.utils';
import { AI_SUMMARY_STATUS } from './ai-summary-status.utils';

const ARCHIVE_SYNC_CONTEXT = 'ArchiveSyncService';
const archiveSyncLogger = {
  log: (message: string) => LoggerUtils.log(ARCHIVE_SYNC_CONTEXT, message),
  warn: (message: string) => LoggerUtils.warn(ARCHIVE_SYNC_CONTEXT, message),
  error: (message: string) => LoggerUtils.error(ARCHIVE_SYNC_CONTEXT, message),
  debug: (message: string) => LoggerUtils.debug(ARCHIVE_SYNC_CONTEXT, message),
  verbose: (message: string) =>
    LoggerUtils.verbose(ARCHIVE_SYNC_CONTEXT, message),
};

type FullSyncApplyTask = {
  key: string;
  notice: CachedNotice;
  reason: ArchiveReason;
};

type PendingRecompareApplyTask = {
  key: string;
  item: INsmBillItem;
};

type SummaryBackfillApplyTask = {
  key: string;
  notice: CachedNotice;
  phase: 'summary-backfill' | 'summary-backfill-retry';
};

let isFullSyncApplyWorkerRunning = false;
let isPendingRecompareApplyWorkerRunning = false;
let isSummaryBackfillApplyWorkerRunning = false;

const FULL_SYNC_APPLY_QUEUE_KEY =
  APP_CONSTANTS.ARCHIVE_SYNC.FULL_SYNC_APPLY_QUEUE_KEY;
const PENDING_RECOMPARE_APPLY_QUEUE_KEY =
  APP_CONSTANTS.ARCHIVE_SYNC.PENDING_RECOMPARE_APPLY_QUEUE_KEY;
const SUMMARY_BACKFILL_APPLY_QUEUE_KEY =
  APP_CONSTANTS.ARCHIVE_SYNC.SUMMARY_BACKFILL_APPLY_QUEUE_KEY;
const ASYNC_APPLY_QUEUE_TTL_SECONDS =
  APP_CONSTANTS.ARCHIVE_SYNC.ASYNC_APPLY_QUEUE_TTL_SECONDS;
const ENABLE_ERROR_AUTO_RETRY = process.env.NODE_ENV !== 'test';
const MAX_ERROR_AUTO_RETRY_ATTEMPTS = (() => {
  const parsed = Number.parseInt(
    process.env.ARCHIVE_SYNC_MAX_ERROR_AUTO_RETRY_ATTEMPTS ?? '8',
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8;
})();
const MAX_ERROR_AUTO_RETRY_DELAY_MS = 60_000;

export interface ArchiveSyncExecutorDeps {
  crawlingCoreService: CrawlingCoreService;
  noticeArchiveService: NoticeArchiveService;
  archiveOrchestratorService: ArchiveOrchestratorService;
  summaryGenerationService: SummaryGenerationService;
  cacheService: CacheService;
  changeTrackingService?: ChangeTrackingService;
  discordBridge?: DiscordBridgeService;
}

export interface ArchiveSyncExecutorOptions {
  crawlerPageUnit: number;
  crawlerConcurrency: number;
  nsmCrawlerConcurrency: number;
  doneCrawlerConcurrency: number;
  crawlerDelayMs: number;
  fullSyncApplyBatchSize: number;
  fullSyncApplyBatchDelayMs: number;
  pendingRecompareApplyBatchSize: number;
  pendingRecompareApplyBatchDelayMs: number;
  summaryBackfillBatchSize: number;
  summaryBackfillConcurrency: number;
  summaryBackfillCpuFriendlyMode: boolean;
  summaryBackfillCpuBatchDelayMs: number;
  donePageMaxRetries: number;
  donePageRetryBaseMs: number;
}

export interface ArchiveSyncAsyncApplyMetrics {
  fullSyncQueueLength: number;
  fullSyncWorkerRunning: boolean;
  fullSyncProcessedTotal: number;
  fullSyncLastBatchProcessed: number;
  fullSyncLastBatchAt: string | null;
  pendingRecompareQueueLength: number;
  pendingRecompareWorkerRunning: boolean;
  pendingRecompareProcessedTotal: number;
  pendingRecompareLastBatchProcessed: number;
  pendingRecompareLastBatchAt: string | null;
  pendingRecompareLastStageAt: string | null;
  pendingRecompareLastStageTrigger: string | null;
  pendingRecompareLastStageRequested: number;
  pendingRecompareLastStageEligible: number;
  pendingRecompareLastStageEnqueued: number;
  pendingRecompareLastStageQueueBefore: number;
  pendingRecompareLastStageQueueAfter: number;
  summaryBackfillQueueLength: number;
  summaryBackfillWorkerRunning: boolean;
  summaryBackfillProcessedTotal: number;
  summaryBackfillLastBatchProcessed: number;
  summaryBackfillLastBatchAt: string | null;
}

let fullSyncQueueLengthSnapshot = 0;
let fullSyncProcessedTotal = 0;
let fullSyncLastBatchProcessed = 0;
let fullSyncLastBatchAt: string | null = null;
let pendingRecompareQueueLengthSnapshot = 0;
let pendingRecompareProcessedTotal = 0;
let pendingRecompareLastBatchProcessed = 0;
let pendingRecompareLastBatchAt: string | null = null;
let pendingRecompareLastStageAt: string | null = null;
let pendingRecompareLastStageTrigger: string | null = null;
let pendingRecompareLastStageRequested = 0;
let pendingRecompareLastStageEligible = 0;
let pendingRecompareLastStageEnqueued = 0;
let pendingRecompareLastStageQueueBefore = 0;
let pendingRecompareLastStageQueueAfter = 0;
let summaryBackfillQueueLengthSnapshot = 0;
let summaryBackfillProcessedTotal = 0;
let summaryBackfillLastBatchProcessed = 0;
let summaryBackfillLastBatchAt: string | null = null;
let fullSyncErrorRetryCount = 0;
let pendingRecompareErrorRetryCount = 0;
let summaryBackfillErrorRetryCount = 0;

function computeErrorRetryDelayMs(
  baseDelayMs: number,
  attempt: number,
): number {
  const normalizedBaseDelay = Math.max(baseDelayMs, 1000);
  const exponent = Math.min(Math.max(attempt - 1, 0), 6);
  const exponentialDelay = normalizedBaseDelay * 2 ** exponent;
  return Math.min(exponentialDelay, MAX_ERROR_AUTO_RETRY_DELAY_MS);
}

function setQueueLengthSnapshot(queueKey: string, length: number): void {
  if (queueKey === FULL_SYNC_APPLY_QUEUE_KEY) {
    fullSyncQueueLengthSnapshot = length;
    return;
  }

  if (queueKey === PENDING_RECOMPARE_APPLY_QUEUE_KEY) {
    pendingRecompareQueueLengthSnapshot = length;
    return;
  }

  if (queueKey === SUMMARY_BACKFILL_APPLY_QUEUE_KEY) {
    summaryBackfillQueueLengthSnapshot = length;
  }
}

async function readApplyQueue<T>(
  deps: ArchiveSyncExecutorDeps,
  queueKey: string,
): Promise<T[]> {
  const queue = await deps.cacheService.getObject<T[]>(queueKey);
  if (!Array.isArray(queue)) {
    setQueueLengthSnapshot(queueKey, 0);
    return [];
  }

  setQueueLengthSnapshot(queueKey, queue.length);
  return queue;
}

async function writeApplyQueue<T>(
  deps: ArchiveSyncExecutorDeps,
  queueKey: string,
  queue: T[],
): Promise<void> {
  const ok = await deps.cacheService.setObject(
    queueKey,
    queue,
    ASYNC_APPLY_QUEUE_TTL_SECONDS,
  );
  if (!ok) {
    throw new Error(`Failed to persist async apply queue (${queueKey})`);
  }

  setQueueLengthSnapshot(queueKey, queue.length);
}

async function enqueueUniqueApplyTasks<T extends { key: string }>(
  deps: ArchiveSyncExecutorDeps,
  queueKey: string,
  tasks: T[],
): Promise<number> {
  if (tasks.length === 0) {
    return 0;
  }

  const queue = await readApplyQueue<T>(deps, queueKey);
  const existingKeys = new Set(queue.map((task) => task.key));
  const additions: T[] = [];

  for (const task of tasks) {
    if (existingKeys.has(task.key)) {
      continue;
    }

    additions.push(task);
    existingKeys.add(task.key);
  }

  if (additions.length === 0) {
    return 0;
  }

  await writeApplyQueue(deps, queueKey, [...queue, ...additions]);
  return additions.length;
}

async function removeApplyTasksByKeys<T extends { key: string }>(
  deps: ArchiveSyncExecutorDeps,
  queueKey: string,
  keys: Set<string>,
): Promise<void> {
  if (keys.size === 0) {
    return;
  }

  const queue = await readApplyQueue<T>(deps, queueKey);
  const next = queue.filter((task) => !keys.has(task.key));
  await writeApplyQueue(deps, queueKey, next);
}

async function withChangeNotificationCollection<T>(
  deps: ArchiveSyncExecutorDeps,
  task: () => Promise<T>,
): Promise<T> {
  deps.noticeArchiveService.beginChangeNotificationCollection();
  try {
    return await task();
  } finally {
    await deps.noticeArchiveService.endChangeNotificationCollection();
  }
}

export function getArchiveSyncAsyncApplyMetrics(): ArchiveSyncAsyncApplyMetrics {
  return {
    fullSyncQueueLength: fullSyncQueueLengthSnapshot,
    fullSyncWorkerRunning: isFullSyncApplyWorkerRunning,
    fullSyncProcessedTotal,
    fullSyncLastBatchProcessed,
    fullSyncLastBatchAt,
    pendingRecompareQueueLength: pendingRecompareQueueLengthSnapshot,
    pendingRecompareWorkerRunning: isPendingRecompareApplyWorkerRunning,
    pendingRecompareProcessedTotal,
    pendingRecompareLastBatchProcessed,
    pendingRecompareLastBatchAt,
    pendingRecompareLastStageAt,
    pendingRecompareLastStageTrigger,
    pendingRecompareLastStageRequested,
    pendingRecompareLastStageEligible,
    pendingRecompareLastStageEnqueued,
    pendingRecompareLastStageQueueBefore,
    pendingRecompareLastStageQueueAfter,
    summaryBackfillQueueLength: summaryBackfillQueueLengthSnapshot,
    summaryBackfillWorkerRunning: isSummaryBackfillApplyWorkerRunning,
    summaryBackfillProcessedTotal,
    summaryBackfillLastBatchProcessed,
    summaryBackfillLastBatchAt,
  };
}

function recordPendingRecompareStage(metrics: {
  trigger: string;
  requested: number;
  eligible: number;
  enqueued: number;
  queueBefore: number;
  queueAfter: number;
}): void {
  pendingRecompareLastStageAt = new Date().toISOString();
  pendingRecompareLastStageTrigger = metrics.trigger;
  pendingRecompareLastStageRequested = metrics.requested;
  pendingRecompareLastStageEligible = metrics.eligible;
  pendingRecompareLastStageEnqueued = metrics.enqueued;
  pendingRecompareLastStageQueueBefore = metrics.queueBefore;
  pendingRecompareLastStageQueueAfter = metrics.queueAfter;
}

export async function refreshArchiveSyncAsyncApplyMetrics(
  deps: ArchiveSyncExecutorDeps,
): Promise<ArchiveSyncAsyncApplyMetrics> {
  await Promise.all([
    readApplyQueue<FullSyncApplyTask>(deps, FULL_SYNC_APPLY_QUEUE_KEY),
    readApplyQueue<PendingRecompareApplyTask>(
      deps,
      PENDING_RECOMPARE_APPLY_QUEUE_KEY,
    ),
    readApplyQueue<SummaryBackfillApplyTask>(
      deps,
      SUMMARY_BACKFILL_APPLY_QUEUE_KEY,
    ),
  ]);

  return getArchiveSyncAsyncApplyMetrics();
}

export function kickArchiveSyncAsyncApplyWorkers(
  deps: ArchiveSyncExecutorDeps,
  options: ArchiveSyncExecutorOptions,
  workerSelection: {
    fullSync?: boolean;
    pendingRecompare?: boolean;
    summaryBackfill?: boolean;
  } = {},
): void {
  const {
    fullSync = true,
    pendingRecompare = true,
    summaryBackfill = true,
  } = workerSelection;

  if (fullSync) {
    void runFullSyncApplyWorker(deps, options);
  }
  if (pendingRecompare) {
    void runPendingRecompareApplyWorker(deps, options);
  }
  if (summaryBackfill) {
    void runSummaryBackfillApplyWorker(deps, options);
  }
}

async function enqueueFullSyncApplyTasks(
  deps: ArchiveSyncExecutorDeps,
  tasks: FullSyncApplyTask[],
): Promise<number> {
  return enqueueUniqueApplyTasks(deps, FULL_SYNC_APPLY_QUEUE_KEY, tasks);
}

async function enqueueSummaryBackfillApplyTasks(
  deps: ArchiveSyncExecutorDeps,
  tasks: SummaryBackfillApplyTask[],
): Promise<number> {
  return enqueueUniqueApplyTasks(deps, SUMMARY_BACKFILL_APPLY_QUEUE_KEY, tasks);
}

async function runFullSyncApplyWorker(
  deps: ArchiveSyncExecutorDeps,
  options: ArchiveSyncExecutorOptions,
): Promise<void> {
  if (isFullSyncApplyWorkerRunning) {
    return;
  }

  isFullSyncApplyWorkerRunning = true;
  let hadError = false;
  try {
    for (;;) {
      const queue = await readApplyQueue<FullSyncApplyTask>(
        deps,
        FULL_SYNC_APPLY_QUEUE_KEY,
      );
      if (queue.length === 0) {
        break;
      }

      const batch = queue.slice(0, options.fullSyncApplyBatchSize);
      const grouped = new Map<ArchiveReason, CachedNotice[]>();
      const batchKeys = new Set(batch.map((task) => task.key));

      for (const task of batch) {
        const existing = grouped.get(task.reason) ?? [];
        existing.push(task.notice);
        grouped.set(task.reason, existing);
      }

      let batchSavedTotal = 0;
      try {
        batchSavedTotal = await withChangeNotificationCollection(
          deps,
          async () => {
            let savedTotal = 0;
            for (const [reason, notices] of grouped.entries()) {
              const saved =
                await deps.archiveOrchestratorService.archiveNotices(notices, {
                  reason,
                });
              savedTotal += saved;
              LoggerUtils.log(
                'ArchiveSyncService',
                `Full sync apply batch: reason=${reason}, requested=${notices.length}, saved=${saved}, queueRemaining=${queue.length}`,
              );
            }

            return savedTotal;
          },
        );

        if (batchSavedTotal === batch.length) {
          await removeApplyTasksByKeys<FullSyncApplyTask>(
            deps,
            FULL_SYNC_APPLY_QUEUE_KEY,
            batchKeys,
          );
        } else {
          const failedCount = batch.length - batchSavedTotal;
          LoggerUtils.warn(
            'ArchiveSyncService',
            `Full sync apply partial batch: requested=${batch.length}, removed=0, failed=${failedCount}`,
          );

          if (failedCount > 0) {
            hadError = true;
            break;
          }
        }
      } catch (error) {
        hadError = true;
        LoggerUtils.error(
          'ArchiveSyncService',
          `Full sync apply batch failed: ${(error as Error).message}`,
          error,
        );
        break;
      }

      fullSyncProcessedTotal += batchSavedTotal;
      fullSyncLastBatchProcessed = batchSavedTotal;
      fullSyncLastBatchAt = new Date().toISOString();

      if (options.fullSyncApplyBatchDelayMs > 0) {
        await delayMs(options.fullSyncApplyBatchDelayMs);
      }
    }
  } finally {
    isFullSyncApplyWorkerRunning = false;
    const remainingQueue = await readApplyQueue<FullSyncApplyTask>(
      deps,
      FULL_SYNC_APPLY_QUEUE_KEY,
    );
    if (remainingQueue.length === 0) {
      fullSyncErrorRetryCount = 0;
    } else if (hadError) {
      if (ENABLE_ERROR_AUTO_RETRY) {
        fullSyncErrorRetryCount += 1;
        if (fullSyncErrorRetryCount > MAX_ERROR_AUTO_RETRY_ATTEMPTS) {
          LoggerUtils.error(
            'ArchiveSyncService',
            `Full sync apply auto-retry exhausted (attempts=${fullSyncErrorRetryCount}, max=${MAX_ERROR_AUTO_RETRY_ATTEMPTS}, queueRemaining=${remainingQueue.length})`,
          );
        } else {
          const retryDelay = computeErrorRetryDelayMs(
            options.fullSyncApplyBatchDelayMs,
            fullSyncErrorRetryCount,
          );
          LoggerUtils.warn(
            'ArchiveSyncService',
            `Full sync apply scheduling retry ${fullSyncErrorRetryCount}/${MAX_ERROR_AUTO_RETRY_ATTEMPTS} in ${retryDelay}ms (queueRemaining=${remainingQueue.length})`,
          );
          void delayMs(retryDelay).then(() =>
            runFullSyncApplyWorker(deps, options),
          );
        }
      } else {
        LoggerUtils.warn(
          'ArchiveSyncService',
          `Full sync apply retry halted in test mode with queueRemaining=${remainingQueue.length}`,
        );
      }
    } else {
      fullSyncErrorRetryCount = 0;
      void runFullSyncApplyWorker(deps, options);
    }
  }
}

async function runPendingRecompareApplyWorker(
  deps: ArchiveSyncExecutorDeps,
  options: ArchiveSyncExecutorOptions,
): Promise<void> {
  if (isPendingRecompareApplyWorkerRunning) {
    return;
  }

  isPendingRecompareApplyWorkerRunning = true;
  let hadError = false;

  try {
    for (;;) {
      const queue = await readApplyQueue<PendingRecompareApplyTask>(
        deps,
        PENDING_RECOMPARE_APPLY_QUEUE_KEY,
      );
      if (queue.length === 0) {
        break;
      }

      const batch = queue.slice(0, options.pendingRecompareApplyBatchSize);
      const batchKeys = new Set(batch.map((task) => task.key));

      const batchTaskNums = new Map<string, number>();
      for (const task of batch) {
        batchTaskNums.set(
          task.key,
          CrawlingCoreService.nsmBillToCachedNotice(task.item).num,
        );
      }

      const recompareEligibleNums =
        await deps.noticeArchiveService.getArchivedNullContentIdNums(
          Array.from(batchTaskNums.values()),
        );
      const eligibleBatch = batch.filter((task) =>
        recompareEligibleNums.has(batchTaskNums.get(task.key) ?? -1),
      );

      // Queue can contain stale items across restarts. If a notice is already
      // PAL-enriched (contentId != null), drop it from pending-recompare queue.
      const succeededKeys = new Set<string>(
        batch
          .filter(
            (task) =>
              !recompareEligibleNums.has(batchTaskNums.get(task.key) ?? -1),
          )
          .map((task) => task.key),
      );

      try {
        if (eligibleBatch.length > 0) {
          const archived = await withChangeNotificationCollection(
            deps,
            async () =>
              deps.archiveOrchestratorService.archiveNsmBillItems(
                eligibleBatch.map((task) => task.item),
                { reason: NsmArchiveReason.EXISTING_PENDING_RECOMPARE },
              ),
          );

          const archivedNums = new Set(archived.map((notice) => notice.num));
          for (const task of eligibleBatch) {
            const num = batchTaskNums.get(task.key);
            if (num !== undefined && archivedNums.has(num)) {
              succeededKeys.add(task.key);
            }
          }
        }

        await removeApplyTasksByKeys<PendingRecompareApplyTask>(
          deps,
          PENDING_RECOMPARE_APPLY_QUEUE_KEY,
          succeededKeys,
        );
        const remainingQueue = await readApplyQueue<PendingRecompareApplyTask>(
          deps,
          PENDING_RECOMPARE_APPLY_QUEUE_KEY,
        );

        pendingRecompareProcessedTotal += succeededKeys.size;
        pendingRecompareLastBatchProcessed = succeededKeys.size;
        pendingRecompareLastBatchAt = new Date().toISOString();
        LoggerUtils.log(
          'ArchiveSyncService',
          `Pending recompare apply batch done: requested=${batch.length}, eligible=${eligibleBatch.length}, removed=${succeededKeys.size}, failed=${batchKeys.size - succeededKeys.size}, queueRemaining=${remainingQueue.length}, processedTotal=${pendingRecompareProcessedTotal}`,
        );

        if (batchKeys.size > 0 && succeededKeys.size === 0) {
          hadError = true;
          LoggerUtils.warn(
            'ArchiveSyncService',
            `Pending recompare apply made no progress for batch of ${batch.length}; scheduling delayed retry`,
          );
          break;
        }
      } catch (error) {
        hadError = true;
        LoggerUtils.error(
          'ArchiveSyncService',
          `Pending recompare apply batch failed: ${(error as Error).message}`,
          error,
        );
        break;
      }

      if (options.pendingRecompareApplyBatchDelayMs > 0) {
        await delayMs(options.pendingRecompareApplyBatchDelayMs);
      }
    }
  } finally {
    isPendingRecompareApplyWorkerRunning = false;
    const remainingQueue = await readApplyQueue<PendingRecompareApplyTask>(
      deps,
      PENDING_RECOMPARE_APPLY_QUEUE_KEY,
    );
    if (remainingQueue.length === 0) {
      pendingRecompareErrorRetryCount = 0;
    } else if (hadError) {
      if (ENABLE_ERROR_AUTO_RETRY) {
        pendingRecompareErrorRetryCount += 1;
        if (pendingRecompareErrorRetryCount > MAX_ERROR_AUTO_RETRY_ATTEMPTS) {
          LoggerUtils.error(
            'ArchiveSyncService',
            `Pending recompare apply auto-retry exhausted (attempts=${pendingRecompareErrorRetryCount}, max=${MAX_ERROR_AUTO_RETRY_ATTEMPTS}, queueRemaining=${remainingQueue.length})`,
          );
        } else {
          const retryDelay = computeErrorRetryDelayMs(
            options.pendingRecompareApplyBatchDelayMs,
            pendingRecompareErrorRetryCount,
          );
          LoggerUtils.warn(
            'ArchiveSyncService',
            `Pending recompare apply scheduling retry ${pendingRecompareErrorRetryCount}/${MAX_ERROR_AUTO_RETRY_ATTEMPTS} in ${retryDelay}ms (queueRemaining=${remainingQueue.length})`,
          );
          void delayMs(retryDelay).then(() =>
            runPendingRecompareApplyWorker(deps, options),
          );
        }
      } else {
        LoggerUtils.warn(
          'ArchiveSyncService',
          `Pending recompare apply retry halted in test mode with queueRemaining=${remainingQueue.length}`,
        );
      }
    } else {
      pendingRecompareErrorRetryCount = 0;
      void runPendingRecompareApplyWorker(deps, options);
    }
  }
}

async function runSummaryBackfillApplyWorker(
  deps: ArchiveSyncExecutorDeps,
  options: ArchiveSyncExecutorOptions,
): Promise<void> {
  if (isSummaryBackfillApplyWorkerRunning) {
    return;
  }

  isSummaryBackfillApplyWorkerRunning = true;
  let hadError = false;

  try {
    for (;;) {
      const queue = await readApplyQueue<SummaryBackfillApplyTask>(
        deps,
        SUMMARY_BACKFILL_APPLY_QUEUE_KEY,
      );
      if (queue.length === 0) {
        break;
      }

      const batch = queue.slice(0, options.summaryBackfillBatchSize);
      const batchKeys = new Set(batch.map((task) => task.key));
      const succeededKeys = new Set<string>();
      const summaryStateUpdates: Array<{
        key: string;
        noticeNum: number;
        summary: string | null;
        status: AISummaryStatus;
      }> = [];
      const batchCacheUpdatesByKey = new Map<string, CachedNotice>();

      try {
        await withChangeNotificationCollection(deps, async () => {
          await mapConcurrently(
            batch,
            options.summaryBackfillConcurrency,
            async (task) => {
              try {
                const result =
                  await deps.summaryGenerationService.generateSummaryForNotice(
                    task.notice,
                    { phase: task.phase },
                  );
                summaryStateUpdates.push({
                  key: task.key,
                  noticeNum: task.notice.num,
                  summary: result.aiSummary,
                  status: result.aiSummaryStatus,
                });
                batchCacheUpdatesByKey.set(task.key, {
                  ...task.notice,
                  aiSummary: result.aiSummary,
                  aiSummaryStatus: result.aiSummaryStatus,
                });
              } catch (error) {
                LoggerUtils.error(
                  'ArchiveSyncService',
                  `Summary backfill apply failed for notice ${task.notice.num}: ${(error as Error).message}`,
                );

                if (task.phase === 'summary-backfill') {
                  summaryStateUpdates.push({
                    key: task.key,
                    noticeNum: task.notice.num,
                    summary: null,
                    status: AI_SUMMARY_STATUS.UNAVAILABLE,
                  });
                  batchCacheUpdatesByKey.set(task.key, {
                    ...task.notice,
                    aiSummary: null,
                    aiSummaryStatus: AI_SUMMARY_STATUS.UNAVAILABLE,
                  });
                } else {
                  // Retry phase rows are already UNAVAILABLE in DB.
                  // Keep queue progress for generation/network failures, but do not
                  // drop rows when DB persistence failed.
                  succeededKeys.add(task.key);
                }
              }
            },
          );

          if (summaryStateUpdates.length > 0) {
            const svcCompat = deps.noticeArchiveService as {
              updateSummaryStatesByNoticeNums?: (
                updates: Array<{
                  noticeNum: number;
                  summary: string | null;
                  status: AISummaryStatus;
                }>,
              ) => Promise<Set<number>>;
              updateSummaryStateByNoticeNum: (
                noticeNum: number,
                summary: string | null,
                status: AISummaryStatus,
              ) => Promise<void>;
            };

            const persistedNoticeNums =
              svcCompat.updateSummaryStatesByNoticeNums
                ? await svcCompat.updateSummaryStatesByNoticeNums(
                    summaryStateUpdates.map((update) => ({
                      noticeNum: update.noticeNum,
                      summary: update.summary,
                      status: update.status,
                    })),
                  )
                : new Set<number>();

            if (!svcCompat.updateSummaryStatesByNoticeNums) {
              for (const update of summaryStateUpdates) {
                await svcCompat.updateSummaryStateByNoticeNum(
                  update.noticeNum,
                  update.summary,
                  update.status,
                );
                persistedNoticeNums.add(update.noticeNum);
              }
            }

            const batchCacheUpdates: CachedNotice[] = [];
            for (const update of summaryStateUpdates) {
              if (!persistedNoticeNums.has(update.noticeNum)) {
                continue;
              }
              succeededKeys.add(update.key);
              const cacheUpdate = batchCacheUpdatesByKey.get(update.key);
              if (cacheUpdate) {
                batchCacheUpdates.push(cacheUpdate);
              }
            }

            if (batchCacheUpdates.length > 0) {
              await deps.cacheService.updateCache(batchCacheUpdates);
            }
          }
        });

        await removeApplyTasksByKeys<SummaryBackfillApplyTask>(
          deps,
          SUMMARY_BACKFILL_APPLY_QUEUE_KEY,
          succeededKeys,
        );
        const remainingQueue = await readApplyQueue<SummaryBackfillApplyTask>(
          deps,
          SUMMARY_BACKFILL_APPLY_QUEUE_KEY,
        );

        summaryBackfillProcessedTotal += succeededKeys.size;
        summaryBackfillLastBatchProcessed = succeededKeys.size;
        summaryBackfillLastBatchAt = new Date().toISOString();

        LoggerUtils.log(
          'ArchiveSyncService',
          `Summary backfill apply batch done: requested=${batch.length}, removed=${succeededKeys.size}, failed=${batchKeys.size - succeededKeys.size}, queueRemaining=${remainingQueue.length}`,
        );

        if (batchKeys.size > 0 && succeededKeys.size === 0) {
          hadError = true;
          LoggerUtils.warn(
            'ArchiveSyncService',
            `Summary backfill apply made no progress for batch of ${batch.length}; scheduling delayed retry`,
          );
          break;
        }

        if (
          options.summaryBackfillCpuFriendlyMode &&
          options.summaryBackfillCpuBatchDelayMs > 0
        ) {
          await delayMs(options.summaryBackfillCpuBatchDelayMs);
        }
      } catch (error) {
        hadError = true;
        LoggerUtils.error(
          'ArchiveSyncService',
          `Summary backfill apply batch failed: ${(error as Error).message}`,
          error,
        );
        break;
      }
    }
  } finally {
    isSummaryBackfillApplyWorkerRunning = false;
    const remainingQueue = await readApplyQueue<SummaryBackfillApplyTask>(
      deps,
      SUMMARY_BACKFILL_APPLY_QUEUE_KEY,
    );
    if (remainingQueue.length === 0) {
      summaryBackfillErrorRetryCount = 0;
    } else if (hadError) {
      if (ENABLE_ERROR_AUTO_RETRY) {
        summaryBackfillErrorRetryCount += 1;
        if (summaryBackfillErrorRetryCount > MAX_ERROR_AUTO_RETRY_ATTEMPTS) {
          LoggerUtils.error(
            'ArchiveSyncService',
            `Summary backfill apply auto-retry exhausted (attempts=${summaryBackfillErrorRetryCount}, max=${MAX_ERROR_AUTO_RETRY_ATTEMPTS}, queueRemaining=${remainingQueue.length})`,
          );
        } else {
          const retryDelay = computeErrorRetryDelayMs(
            1000,
            summaryBackfillErrorRetryCount,
          );
          LoggerUtils.warn(
            'ArchiveSyncService',
            `Summary backfill apply scheduling retry ${summaryBackfillErrorRetryCount}/${MAX_ERROR_AUTO_RETRY_ATTEMPTS} in ${retryDelay}ms (queueRemaining=${remainingQueue.length})`,
          );
          void delayMs(retryDelay).then(() =>
            runSummaryBackfillApplyWorker(deps, options),
          );
        }
      } else {
        LoggerUtils.warn(
          'ArchiveSyncService',
          `Summary backfill apply retry halted in test mode with queueRemaining=${remainingQueue.length}`,
        );
      }
    } else {
      summaryBackfillErrorRetryCount = 0;
      void runSummaryBackfillApplyWorker(deps, options);
    }
  }
}

export async function executeFullSyncPhase(
  deps: ArchiveSyncExecutorDeps,
  options: ArchiveSyncExecutorOptions,
): Promise<FullSyncResult> {
  LoggerUtils.log('ArchiveSyncService', 'Full archive sync started');
  LoggerUtils.debugDev(
    'ArchiveSyncService',
    `Full sync config: pageUnit=${options.crawlerPageUnit}, delayMs=${options.crawlerDelayMs}, concurrency=${options.crawlerConcurrency}`,
  );

  let totalPagesScanned = 0;
  let totalNoticesScanned = 0;
  let newlyArchivedCount = 0;
  let stagedApplyCount = 0;
  let stagedUpgradeCount = 0;
  const seenPalActiveNums = new Set<number>();
  const applyTasks: FullSyncApplyTask[] = [];

  deps.noticeArchiveService.beginChangeNotificationCollection();

  try {
    for await (const page of deps.crawlingCoreService.getAllPages(
      { pageUnit: options.crawlerPageUnit },
      {
        delayMs: options.crawlerDelayMs,
        concurrency: options.crawlerConcurrency,
      },
    )) {
      totalPagesScanned++;
      const pageItems: ITableData[] = page.items ?? [];
      for (const item of pageItems) {
        seenPalActiveNums.add(item.num);
      }
      totalNoticesScanned += pageItems.length;

      const newNotices =
        await deps.archiveOrchestratorService.filterAlreadyArchivedNotices(
          pageItems,
        );

      if (newNotices.length > 0) {
        const staged = newNotices.map((n) => ({
          key: `${ArchiveReason.FULL_SYNC_NEW_NOTICES}:${n.num}`,
          notice: {
            ...n,
            aiSummary: null,
            aiSummaryStatus: 'not_requested' as const,
          },
          reason: ArchiveReason.FULL_SYNC_NEW_NOTICES,
        }));
        applyTasks.push(...staged);
        newlyArchivedCount += newNotices.length;
        stagedApplyCount += staged.length;
      }

      const newNums = new Set(newNotices.map((n) => n.num));
      const alreadyArchivedWithContentId = pageItems.filter(
        (item) => !newNums.has(item.num) && item.contentId !== null,
      );
      if (alreadyArchivedWithContentId.length > 0) {
        const nullContentIdNums =
          await deps.noticeArchiveService.getArchivedNullContentIdNums(
            alreadyArchivedWithContentId.map((i) => i.num),
          );
        if (nullContentIdNums.size > 0) {
          const toUpgrade = alreadyArchivedWithContentId.filter((item) =>
            nullContentIdNums.has(item.num),
          );

          const stagedUpgrades = toUpgrade.map((item) => ({
            key: `${ArchiveReason.NSM_PAL_UPGRADE}:${item.num}`,
            notice: {
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
            },
            reason: ArchiveReason.NSM_PAL_UPGRADE,
          }));
          applyTasks.push(...stagedUpgrades);
          stagedUpgradeCount += stagedUpgrades.length;
          const upgraded = stagedUpgrades.length;
          if (upgraded > 0) {
            logAndBridge({
              logger: {
                log: (message: string) =>
                  LoggerUtils.logDev('ArchiveSyncService', message),
              },
              method: 'log',
              message: `Upgraded ${upgraded} pending bill(s) from NSM to PAL with full archive refresh`,
              context: 'ArchiveSyncService',
              discordBridge: deps.discordBridge,
              bridgeLevel: BridgeLogLevel.DEBUG,
              bridgeMessage: `NSM->PAL archive refresh applied: upgraded **${upgraded}** bill(s) on full sync`,
              metadata: {
                upgraded,
                detected: toUpgrade.length,
                sampleNoticeNums: toUpgrade
                  .slice(0, 10)
                  .map((item) => item.num),
              },
            });
          }
        }
      }

      LoggerUtils.log(
        'ArchiveSyncService',
        `Page ${page.currentPage}/${page.totalPages}: total=${pageItems.length} new=${newNotices.length}`,
      );
    }

    await enqueueFullSyncApplyTasks(deps, applyTasks);
    void runFullSyncApplyWorker(deps, options);

    LoggerUtils.log(
      'ArchiveSyncService',
      `Full sync progress done: pages=${totalPagesScanned}, scanned=${totalNoticesScanned}, newlyArchived=${newlyArchivedCount}, stagedApply=${stagedApplyCount}, stagedUpgrade=${stagedUpgradeCount}, applyQueue=${fullSyncQueueLengthSnapshot}, palSeen=${seenPalActiveNums.size}`,
    );

    return { totalPagesScanned, totalNoticesScanned, newlyArchivedCount };
  } finally {
    await deps.noticeArchiveService.endChangeNotificationCollection();
  }
}

export async function executePendingSyncPhase(
  deps: ArchiveSyncExecutorDeps,
  options: ArchiveSyncExecutorOptions,
  runtime?: {
    trigger?: string;
  },
): Promise<PendingSyncResult> {
  LoggerUtils.logDev(
    'ArchiveSyncService',
    'Pending bills sync (NsmLmSts) started',
  );

  deps.noticeArchiveService.beginChangeNotificationCollection();

  try {
    const pendingPhaseStartedAt = Date.now();
    const rawItemMap = new Map<number, INsmBillItem>();
    const nsmNotices: ReturnType<
      typeof CrawlingCoreService.nsmBillToCachedNotice
    >[] = [];
    const pendingCandidateNums = new Set<number>();
    const query = { pageSize: options.crawlerPageUnit };
    const sharedNsmConcurrency = Math.max(1, options.nsmCrawlerConcurrency);
    const allStreamConcurrency = Math.max(
      1,
      Math.floor(sharedNsmConcurrency / 2),
    );
    const pendingStreamConcurrency = Math.max(
      1,
      sharedNsmConcurrency - allStreamConcurrency,
    );
    const allCrawlOptions = {
      delayMs: APP_CONSTANTS.ARCHIVE_SYNC.NSM_CRAWLER_DELAY_MS,
      concurrency: allStreamConcurrency,
    };
    const pendingCrawlOptions = {
      delayMs: APP_CONSTANTS.ARCHIVE_SYNC.NSM_CRAWLER_DELAY_MS,
      concurrency: pendingStreamConcurrency,
    };
    let allPagesScanned = 0;
    let pendingPagesScanned = 0;
    let allItemsObserved = 0;
    let pendingItemsObserved = 0;
    const isPendingLike = (item: INsmBillItem): boolean =>
      item.progressStatus?.trim() === '발의';
    const collectPageItems = (
      items: INsmBillItem[] | null | undefined,
      source: 'all' | 'pending',
    ) => {
      for (const item of items ?? []) {
        const notice = CrawlingCoreService.nsmBillToCachedNotice(item);
        if (!rawItemMap.has(notice.num)) {
          rawItemMap.set(notice.num, item);
          nsmNotices.push(notice);
        }
        if (source === 'pending' || isPendingLike(item)) {
          pendingCandidateNums.add(notice.num);
        }
      }
    };

    LoggerUtils.debugDev(
      'ArchiveSyncService',
      `Pending sync scan config: pageSize=${options.crawlerPageUnit}, sharedConcurrency=${sharedNsmConcurrency}, allConcurrency=${allStreamConcurrency}, pendingConcurrency=${pendingStreamConcurrency}, delayMs=${APP_CONSTANTS.ARCHIVE_SYNC.NSM_CRAWLER_DELAY_MS}`,
    );

    const scanAllStream = async () => {
      for await (const page of deps.crawlingCoreService.getAllNsmPages(
        query,
        allCrawlOptions,
      )) {
        allPagesScanned++;
        const pageItems = page.items ?? [];
        allItemsObserved += pageItems.length;
        collectPageItems(pageItems, 'all');
        LoggerUtils.log(
          'ArchiveSyncService',
          `Pending sync NSM(all) page ${page.currentPage}/${page.totalPages}: pageItems=${pageItems.length}, uniqueAccum=${nsmNotices.length}, pendingCandidates=${pendingCandidateNums.size}`,
        );
      }
    };

    const scanPendingStream = async () => {
      for await (const page of deps.crawlingCoreService.getAllNsmPendingPages(
        query,
        pendingCrawlOptions,
      )) {
        pendingPagesScanned++;
        const pageItems = page.items ?? [];
        pendingItemsObserved += pageItems.length;
        collectPageItems(pageItems, 'pending');
        LoggerUtils.log(
          'ArchiveSyncService',
          `Pending sync NSM(pending) page ${page.currentPage}/${page.totalPages}: pageItems=${pageItems.length}, uniqueAccum=${nsmNotices.length}, pendingCandidates=${pendingCandidateNums.size}`,
        );
      }
    };

    const scanStartedAt = Date.now();
    // Serialize streams to avoid triggering the Waitingroom with concurrent
    // requests from the same IP. The NSM site enqueues IPs that hit it too
    // aggressively, so running both streams in parallel compounds the issue.
    let scanError: unknown = null;
    try {
      await scanAllStream();
      await scanPendingStream();
    } catch (error) {
      scanError = error;
      LoggerUtils.log(
        'ArchiveSyncService',
        `Pending sync scan encountered error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const scanElapsedMs = Date.now() - scanStartedAt;
    LoggerUtils.log(
      'ArchiveSyncService',
      `Pending sync scan done: allPages=${allPagesScanned}, pendingPages=${pendingPagesScanned}, allItems=${allItemsObserved}, pendingItems=${pendingItemsObserved}, unique=${nsmNotices.length}, scanMs=${scanElapsedMs}`,
    );

    // ── NSM source-missing detection ──────────────────────────────────
    // Runs AFTER the full list crawl completes successfully.  A partial
    // scan (e.g. Waitingroom 307 after Puppeteer fallback) means some
    // pages were never visited, so bills on those pages would be falsely
    // absent from seenNsmActiveNums and incorrectly marked source_deleted.
    const seenNsmActiveNums = new Set(rawItemMap.keys());
    let sourceDeletedCount = 0;
    if (scanError) {
      LoggerUtils.log(
        'ArchiveSyncService',
        `Skipping NSM source-missing detection: scan error occurred (${seenNsmActiveNums.size} items collected, scan incomplete)`,
      );
    } else if (seenNsmActiveNums.size > 0) {
      sourceDeletedCount =
        await deps.noticeArchiveService.markSourceDeletedByMissingNsmNums(
          seenNsmActiveNums,
        );
      if (sourceDeletedCount > 0) {
        LoggerUtils.log(
          'ArchiveSyncService',
          `Pending sync marked ${sourceDeletedCount} notice(s) as source_deleted after NSM reconciliation (seenNsmNums=${seenNsmActiveNums.size})`,
        );
      }
    }
    // ──────────────────────────────────────────────────────────────────

    // ── NSM detail-page probe ─────────────────────────────────────────
    // Bills that are still in the NSM list but deleted on the detail page
    // (e.g.国民참여입법센터 list API returns them but detail shows
    // "안건정보가 없습니다") are not caught by list-based detection.
    // Probe ALL content_bill_number IS NULL bills (typically <50) since
    // these are the strongest deletion candidates (detail page never captured).
    const NSM_DETAIL_PROBE_BATCH_SIZE = 50;
    let detailProbeDeletedCount = 0;
    try {
      detailProbeDeletedCount =
        await deps.archiveOrchestratorService.probeExistingNsmBillsForSourceDeletion(
          NSM_DETAIL_PROBE_BATCH_SIZE,
        );
      if (detailProbeDeletedCount > 0) {
        LoggerUtils.log(
          'ArchiveSyncService',
          `NSM detail probe confirmed ${detailProbeDeletedCount} deleted bill(s)`,
        );
      }
    } catch (error) {
      LoggerUtils.log(
        'ArchiveSyncService',
        `NSM detail probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    sourceDeletedCount += detailProbeDeletedCount;
    // ──────────────────────────────────────────────────────────────────

    const totalScanned = nsmNotices.length;

    if (totalScanned === 0) {
      LoggerUtils.log(
        'ArchiveSyncService',
        'No NSM bills found during pending sync',
      );
      LoggerUtils.debugDev(
        'ArchiveSyncService',
        `Pending sync timing: totalMs=${Date.now() - pendingPhaseStartedAt}, scanMs=${scanElapsedMs}, classifyMs=0, archiveMs=0`,
      );
      return { totalScanned: 0, newlyArchivedCount: 0, sourceDeletedCount };
    }

    if (scanError) {
      // The scan failed (e.g. Waitingroom 307 after Puppeteer fallback).
      // Source-missing detection was already skipped above due to the
      // incomplete scan.  Skip archival of new items and return partial
      // results so that the next successful run covers the missing bills.
      LoggerUtils.log(
        'ArchiveSyncService',
        'Pending sync skipping archival and source-missing detection due to scan error',
      );
      return { totalScanned, newlyArchivedCount: 0, sourceDeletedCount };
    }

    const classifyStartedAt = Date.now();
    const newNsmNotices =
      await deps.archiveOrchestratorService.filterAlreadyArchivedNotices(
        nsmNotices,
      );
    const newPendingNotices = newNsmNotices.filter((notice) =>
      pendingCandidateNums.has(notice.num),
    );
    const newSyncOnlyItems = newNsmNotices
      .filter((notice) => !pendingCandidateNums.has(notice.num))
      .map((notice) => rawItemMap.get(notice.num))
      .filter((item): item is INsmBillItem => item !== undefined);
    const classifyElapsedMs = Date.now() - classifyStartedAt;

    LoggerUtils.debugDev(
      'ArchiveSyncService',
      `Pending sync classify: scanned=${totalScanned}, newAll=${newNsmNotices.length}, newPending=${newPendingNotices.length}, newSyncOnly=${newSyncOnlyItems.length}, classifyMs=${classifyElapsedMs}`,
    );

    const archiveStartedAt = Date.now();
    let newlyArchivedCount = 0;
    if (newSyncOnlyItems.length > 0) {
      const archived =
        await deps.archiveOrchestratorService.archiveNsmBillItems(
          newSyncOnlyItems,
          { reason: NsmArchiveReason.NEW_SYNC_ONLY_BILLS },
        );
      newlyArchivedCount += archived.length;
      LoggerUtils.debugDev(
        'ArchiveSyncService',
        `Pending sync archived sync-only: requested=${newSyncOnlyItems.length}, archived=${archived.length}`,
      );
    }

    if (newPendingNotices.length > 0) {
      const newPendingItems = newPendingNotices
        .map((n) => rawItemMap.get(n.num))
        .filter((item): item is INsmBillItem => item !== undefined);
      const archived =
        await deps.archiveOrchestratorService.archiveNsmBillItems(
          newPendingItems,
          { reason: NsmArchiveReason.NEW_PENDING_BILLS },
        );
      newlyArchivedCount += archived.length;
      LoggerUtils.debugDev(
        'ArchiveSyncService',
        `Pending sync archived pending: requested=${newPendingItems.length}, archived=${archived.length}`,
      );
    }

    recordPendingRecompareStage({
      trigger: runtime?.trigger ?? 'manual',
      requested: 0,
      eligible: 0,
      enqueued: 0,
      queueBefore: pendingRecompareQueueLengthSnapshot,
      queueAfter: pendingRecompareQueueLengthSnapshot,
    });
    LoggerUtils.logDev(
      'ArchiveSyncService',
      `Pending sync delegated recompare handling to pending change-detection workflow (trigger=${runtime?.trigger ?? 'manual'})`,
    );
    const archiveElapsedMs = Date.now() - archiveStartedAt;

    const totalElapsedMs = Date.now() - pendingPhaseStartedAt;

    logAndBridge({
      logger: archiveSyncLogger,
      method: 'log',
      message:
        `Pending sync done - scanned=${totalScanned} new=${newNsmNotices.length} ` +
        `newPending=${newPendingNotices.length} syncOnly=${newSyncOnlyItems.length} ` +
        `sourceDeleted=${sourceDeletedCount}`,
      context: ARCHIVE_SYNC_CONTEXT,
      discordBridge: deps.discordBridge,
      bridgeMessage:
        `Pending sync complete - scanned=${totalScanned} new=${newNsmNotices.length} ` +
        `newPending=${newPendingNotices.length} syncOnly=${newSyncOnlyItems.length} ` +
        `sourceDeleted=${sourceDeletedCount}`,
    });

    LoggerUtils.debugDev(
      'ArchiveSyncService',
      `Pending sync timing: totalMs=${totalElapsedMs}, scanMs=${scanElapsedMs}, classifyMs=${classifyElapsedMs}, archiveMs=${archiveElapsedMs}`,
    );

    return { totalScanned, newlyArchivedCount, sourceDeletedCount };
  } finally {
    await deps.noticeArchiveService.endChangeNotificationCollection();
  }
}

export async function fetchDonePageWithRetry(
  deps: ArchiveSyncExecutorDeps,
  options: ArchiveSyncExecutorOptions,
  pageIndex: number,
): Promise<ISearchResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.donePageMaxRetries; attempt++) {
    try {
      return await deps.crawlingCoreService.searchDone({
        pageIndex,
        pageUnit: options.crawlerPageUnit,
      });
    } catch (error) {
      lastError = error;
      if (attempt < options.donePageMaxRetries) {
        const backoff = options.donePageRetryBaseMs * (attempt + 1);
        logAndBridge({
          logger: archiveSyncLogger,
          method: 'warn',
          message: `isDone page ${pageIndex} failed (attempt ${attempt + 1}/${options.donePageMaxRetries + 1}): ${(error as Error).message} - retrying in ${backoff}ms`,
          context: ARCHIVE_SYNC_CONTEXT,
          discordBridge: deps.discordBridge,
          bridgeMessage: `isDone page **${pageIndex}** failed (attempt ${attempt + 1}/${options.donePageMaxRetries + 1}): ${(error as Error).message} - retrying in ${backoff}ms`,
        });
        await delayMs(backoff);
      }
    }
  }
  throw lastError;
}

export async function reconcileIsDonePhase(
  deps: ArchiveSyncExecutorDeps,
  options: ArchiveSyncExecutorOptions,
): Promise<IsDoneSyncResult> {
  LoggerUtils.log('ArchiveSyncService', 'isDone reconciliation started');

  let markedDoneCount = 0;
  let fetchedDoneCount = 0;

  const firstPage = await fetchDonePageWithRetry(deps, options, 1);
  const totalPages = firstPage.totalPages;
  LoggerUtils.log(
    'ArchiveSyncService',
    `isDone sync config: pageUnit=${options.crawlerPageUnit}, delayMs=${options.crawlerDelayMs}, totalPages=${totalPages}, concurrency=${options.doneCrawlerConcurrency}`,
  );

  let pageNums = (firstPage.items ?? []).map((item) => item.num);
  fetchedDoneCount += pageNums.length;
  markedDoneCount +=
    await deps.noticeArchiveService.markNoticesDoneByNums(pageNums);
  LoggerUtils.log(
    'ArchiveSyncService',
    `isDone sync page 1/${totalPages}: fetchedPage=${pageNums.length}, fetchedAccum=${fetchedDoneCount}, markedAccum=${markedDoneCount}`,
  );

  const remainingPageIndexes = Array.from(
    { length: Math.max(0, totalPages - 1) },
    (_, index) => index + 2,
  );

  const remainingPages = await mapConcurrently(
    remainingPageIndexes,
    options.doneCrawlerConcurrency,
    async (pageIndex, index) => {
      const staggerSlots = Math.max(1, options.doneCrawlerConcurrency);
      const staggerMs = options.crawlerDelayMs * (index % staggerSlots);
      if (staggerMs > 0) {
        await delayMs(staggerMs);
      }
      return fetchDonePageWithRetry(deps, options, pageIndex);
    },
  );

  for (let i = 0; i < remainingPages.length; i++) {
    const pageIndex = remainingPageIndexes[i];
    const page = remainingPages[i];
    pageNums = (page.items ?? []).map((item) => item.num);
    fetchedDoneCount += pageNums.length;
    markedDoneCount +=
      await deps.noticeArchiveService.markNoticesDoneByNums(pageNums);
    LoggerUtils.log(
      'ArchiveSyncService',
      `isDone sync page ${pageIndex}/${totalPages}: fetchedPage=${pageNums.length}, fetchedAccum=${fetchedDoneCount}, markedAccum=${markedDoneCount}`,
    );
  }

  logAndBridge({
    logger: archiveSyncLogger,
    method: 'log',
    message: `isDone reconciliation done - fetched=${fetchedDoneCount} marked=${markedDoneCount}`,
    context: ARCHIVE_SYNC_CONTEXT,
    discordBridge: deps.discordBridge,
    bridgeMessage: `isDone sync complete - fetched=${fetchedDoneCount} marked=${markedDoneCount}`,
  });

  return { fetchedDoneCount, markedDoneCount };
}

export async function executeSummaryBackfillPhase(
  deps: ArchiveSyncExecutorDeps,
  options: ArchiveSyncExecutorOptions,
): Promise<SummaryBackfillResult> {
  if (!deps.summaryGenerationService.isAiSummaryEnabled()) {
    LoggerUtils.debugDev(
      'ArchiveSyncService',
      'Summary backfill skipped - AI summary disabled',
    );
    return {
      scanned: 0,
      generated: 0,
      skipped: 0,
      failed: 0,
      retryScanned: 0,
      recovered: 0,
      stillFailed: 0,
    };
  }

  let scanned = 0;
  let retryScanned = 0;
  let stagedPending = 0;
  let stagedRetry = 0;
  let summaryBatchIndex = 0;
  let summaryRecoveryBatchIndex = 0;
  let retryBatchIndex = 0;

  const cpuFriendlyMode = options.summaryBackfillCpuFriendlyMode;
  const cpuFriendlyBatchDelayMs = Math.max(
    0,
    options.summaryBackfillCpuBatchDelayMs,
  );

  LoggerUtils.debugDev(
    'ArchiveSyncService',
    `Summary backfill config: batchSize=${options.summaryBackfillBatchSize}, concurrency=${options.summaryBackfillConcurrency}, cpuFriendlyMode=${cpuFriendlyMode}, cpuBatchDelayMs=${cpuFriendlyBatchDelayMs}`,
  );

  const archiveSvcCompat = deps.noticeArchiveService as {
    getPendingSummaryPageByOffset?: (
      skip: number,
      take: number,
    ) => Promise<CachedNotice[]>;
    getNotSupportedSummaryRecoveryPage?: (
      skip: number,
      take: number,
    ) => Promise<CachedNotice[]>;
    getPendingSummaryPage: (take: number) => Promise<CachedNotice[]>;
  };

  // Drain any pre-existing summary queue first so staging scans a stable DB state.
  await runSummaryBackfillApplyWorker(deps, options);

  let pendingSkip = 0;
  for (;;) {
    const batch = archiveSvcCompat.getPendingSummaryPageByOffset
      ? await archiveSvcCompat.getPendingSummaryPageByOffset(
          pendingSkip,
          options.summaryBackfillBatchSize,
        )
      : await archiveSvcCompat.getPendingSummaryPage(
          options.summaryBackfillBatchSize,
        );
    if (batch.length === 0) break;
    summaryBatchIndex++;

    const staged = await enqueueSummaryBackfillApplyTasks(
      deps,
      batch.map((notice) => ({
        key: `pending:${notice.num}`,
        notice,
        phase: 'summary-backfill' as const,
      })),
    );

    stagedPending += staged;
    scanned += batch.length;
    LoggerUtils.log(
      'ArchiveSyncService',
      `Summary backfill staged batch ${summaryBatchIndex}: batchSize=${batch.length}, scannedAccum=${scanned}, stagedAccum=${stagedPending}`,
    );
    pendingSkip += options.summaryBackfillBatchSize;
    if (batch.length < options.summaryBackfillBatchSize) break;
  }

  let recoverySkip = 0;
  for (;;) {
    const batch = archiveSvcCompat.getNotSupportedSummaryRecoveryPage
      ? await archiveSvcCompat.getNotSupportedSummaryRecoveryPage(
          recoverySkip,
          options.summaryBackfillBatchSize,
        )
      : [];
    if (batch.length === 0) break;
    summaryRecoveryBatchIndex++;

    const staged = await enqueueSummaryBackfillApplyTasks(
      deps,
      batch.map((notice) => ({
        key: `recovery:${notice.num}`,
        notice,
        phase: 'summary-backfill' as const,
      })),
    );

    stagedPending += staged;
    scanned += batch.length;
    LoggerUtils.debugDev(
      'ArchiveSyncService',
      `Summary recovery staged batch ${summaryRecoveryBatchIndex}: batchSize=${batch.length}, scannedAccum=${scanned}, stagedAccum=${stagedPending}`,
    );

    recoverySkip += options.summaryBackfillBatchSize;
    if (batch.length < options.summaryBackfillBatchSize) break;
  }

  let unavailableSkip = 0;
  for (;;) {
    const batch = await deps.noticeArchiveService.getUnavailableSummaryPage(
      unavailableSkip,
      options.summaryBackfillBatchSize,
    );
    if (batch.length === 0) break;
    retryBatchIndex++;

    const staged = await enqueueSummaryBackfillApplyTasks(
      deps,
      batch.map((notice) => ({
        key: `retry:${notice.num}`,
        notice,
        phase: 'summary-backfill-retry' as const,
      })),
    );

    stagedRetry += staged;

    retryScanned += batch.length;
    LoggerUtils.debugDev(
      'ArchiveSyncService',
      `Summary backfill retry staged batch ${retryBatchIndex}: batchSize=${batch.length}, retryScannedAccum=${retryScanned}, stagedRetryAccum=${stagedRetry}`,
    );
    unavailableSkip += options.summaryBackfillBatchSize;
    if (batch.length < options.summaryBackfillBatchSize) break;
  }

  // Start the worker only after staging is complete to avoid skip/offset races.
  if (cpuFriendlyMode) {
    await runSummaryBackfillApplyWorker(deps, options);
  } else {
    void runSummaryBackfillApplyWorker(deps, options);
  }

  LoggerUtils.log(
    'ArchiveSyncService',
    `Summary backfill staged - scanned=${scanned} stagedPending=${stagedPending} retryScanned=${retryScanned} stagedRetry=${stagedRetry} queue=${summaryBackfillQueueLengthSnapshot}`,
  );

  return {
    scanned,
    generated: 0,
    skipped: 0,
    failed: 0,
    retryScanned,
    recovered: 0,
    stillFailed: 0,
  };
}

export async function executeChainIntegrityAuditPhase(
  deps: ArchiveSyncExecutorDeps,
): Promise<ChainIntegrityAuditResult> {
  LoggerUtils.debugDev(
    'ArchiveSyncService',
    'Chain integrity audit phase started (scope=daily)',
  );

  if (!deps.changeTrackingService) {
    LoggerUtils.warn(
      'ArchiveSyncService',
      'Chain integrity audit skipped - ChangeTrackingService unavailable',
    );
    return {
      checkedAt: new Date().toISOString(),
      scope: 'daily',
      noticeCount: 0,
      eventCount: 0,
      failureCount: 0,
      checkpointRootHash: null,
      skipped: true,
    };
  }

  const report =
    await deps.changeTrackingService.runScheduledChainAudit('daily');

  LoggerUtils.debugDev(
    'ArchiveSyncService',
    `Chain integrity audit done: scope=${report.scope}, notice=${report.noticeCount}, event=${report.eventCount}, failures=${report.failureCount}`,
  );

  return {
    checkedAt: report.checkedAt,
    scope: report.scope,
    noticeCount: report.noticeCount,
    eventCount: report.eventCount,
    failureCount: report.failureCount,
    checkpointRootHash: report.checkpointRootHash,
    skipped: false,
  };
}
