import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { WebhookService } from '../webhook/webhook.service';
import { CrawlingService } from '../crawling/crawling.service';
import { NoticeArchiveService } from '../notice/notice-archive.service';
import { ArchiveSyncService } from '../crawling/archive-sync.service';
import { ChangeTrackingService } from '../change-tracking/change-tracking.service';
import { WebPushSubscriptionService } from '../notification/web-push-subscription.service';
import { APP_CONSTANTS } from '../../config/app.config';
import cronstrue from 'cronstrue/i18n';

/**
 * Maps known cron expressions to interval (ms) for UI timer calculations.
 */
const CRON_INTERVAL_MAP: Record<string, number> = {
  [APP_CONSTANTS.CRON.EXPRESSIONS.CRAWLING_CHECK]: 600_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.PENDING_CRAWLING_CHECK]: 1_200_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.IS_DONE_SYNC]: 21_600_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.PROPOSAL_REASON_BACKFILL_DRAIN]: 900_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.INTEGRITY_RESCAN]: 86_400_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.CHANGE_TRACKING_DAILY_AUDIT]: 86_400_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.CHANGE_TRACKING_WEEKLY_AUDIT]: 604_800_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.WEBHOOK_CLEANUP]: 86_400_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.WEBHOOK_OPTIMIZATION]: 86_400_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.SYSTEM_MONITORING]: 3_600_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.QUICK_KEYWORDS_REFRESH]: 3_600_000,
  [APP_CONSTANTS.CRON.EXPRESSIONS.SQLITE_VACUUM]: 604_800_000,
};

function resolveCronDisplay(expr: string): {
  intervalMs: number;
  description: string;
} {
  let description: string;
  try {
    description = cronstrue.toString(expr, {
      locale: 'ko',
      use24HourTimeFormat: true,
    });
  } catch {
    description = expr;
  }

  return {
    intervalMs: CRON_INTERVAL_MAP[expr] ?? 0,
    description,
  };
}

@Injectable()
export class RuntimeStatsService implements OnModuleInit, OnModuleDestroy {
  private eventLoopStats: any = null;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly measurementInterval = 2000;

  onModuleInit() {
    this.startEventLoopMonitor();
  }

  onModuleDestroy() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private startEventLoopMonitor() {
    const h = monitorEventLoopDelay({ resolution: 20 });
    h.enable();
    this.intervalId = setInterval(() => {
      this.eventLoopStats = {
        min: Math.round(h.min / 1e6),
        max: Math.round(h.max / 1e6),
        mean: Math.round(h.mean / 1e6),
        stddev: Math.round(h.stddev / 1e6),
        percentiles: {
          p50: Math.round(h.percentile(50) / 1e6),
          p90: Math.round(h.percentile(90) / 1e6),
          p99: Math.round(h.percentile(99) / 1e6),
        },
        exceeds: h.exceeds,
        lastUpdated: Date.now(),
      };
      h.reset();
    }, this.measurementInterval);
  }

  async getAggregatedStats(
    params: { nodeEnv?: string },
    webhookService: WebhookService,
    crawlingService: CrawlingService,
    noticeArchiveService: NoticeArchiveService,
    archiveSyncService?: ArchiveSyncService,
    changeTrackingService?: ChangeTrackingService,
    webPushSubscriptionService?: WebPushSubscriptionService,
  ) {
    const nodeEnv = params.nodeEnv;
    if (!webhookService || !crawlingService || !noticeArchiveService) {
      throw new Error('All service dependencies must be provided');
    }
    const [
      webhookStats,
      cacheInfo,
      archiveCount,
      ollamaMetrics,
      comparableChangeSummary,
      webPushStats,
    ] = await Promise.all([
      webhookService.getDetailedStatsForApi({ nodeEnv }),
      crawlingService.getCacheInfo(),
      noticeArchiveService.getArchiveCount(),
      crawlingService.getOllamaMetrics(),
      changeTrackingService?.getComparableChangeSummary() ??
        Promise.resolve({ comparableEventTotal: 0, comparableNoticeCount: 0 }),
      webPushSubscriptionService?.getStatsForApi() ??
        Promise.resolve({
          total: 0,
          active: 0,
          inactive: 0,
          withFailures: 0,
        }),
    ]);
    const nodeRuntime = this.getNodeRuntimeStats();
    const isProduction = nodeEnv === 'production';
    return {
      webhooks: webhookStats,
      cache: isProduction
        ? {
            size: cacheInfo.size,
            lastUpdated: cacheInfo.lastUpdated,
            maxSize: cacheInfo.maxSize,
            isInitialized: cacheInfo.isInitialized,
          }
        : cacheInfo,
      archive: {
        count: archiveCount,
        isDoneSync: archiveSyncService?.getIsDoneSyncStatus() ?? null,
        legacyGenesisSeed:
          archiveSyncService?.getLegacyGenesisSeedStatus() ?? null,
      },
      webPush: webPushStats,
      changeTracking: comparableChangeSummary,
      ollama: isProduction
        ? {
            enabled: ollamaMetrics.enabled,
            configured: ollamaMetrics.configured,
            model: ollamaMetrics.model,
            summary: {
              total: ollamaMetrics.summary.total,
              success: ollamaMetrics.summary.success,
              failed: ollamaMetrics.summary.failed,
              skipped: ollamaMetrics.summary.skipped,
              successRate: ollamaMetrics.summary.successRate,
            },
            health: {
              status: ollamaMetrics.health.status,
              lastCheckedAt: ollamaMetrics.health.lastCheckedAt,
              lastLatencyMs: ollamaMetrics.health.lastLatencyMs,
              availableModelCount: ollamaMetrics.health.availableModelCount,
            },
          }
        : ollamaMetrics,
      aiSummaryEnabled: (await crawlingService.getOllamaMetrics()).enabled,
      nodeRuntime,
      crawlers: this.buildCrawlersStatus(crawlingService, archiveSyncService),
    };
  }

  getNodeRuntimeStats() {
    return {
      eventLoopDelay: this.eventLoopStats,
      memory: process.memoryUsage(),
    };
  }

  private buildCrawlersStatus(
    crawlingService: CrawlingService,
    archiveSyncService?: ArchiveSyncService,
  ) {
    const schedulerState = crawlingService.getSchedulerExecutionState();
    const archiveState = archiveSyncService?.getExecutionState() ?? null;

    const palPhase = archiveState?.phases.find((p) => p.name === 'full sync');
    const pendingSyncPhase = archiveState?.phases.find(
      (p) => p.name === 'pending sync',
    );

    const palCron = APP_CONSTANTS.CRON.EXPRESSIONS.CRAWLING_CHECK;
    const nsmCron = APP_CONSTANTS.CRON.EXPRESSIONS.PENDING_CRAWLING_CHECK;

    return {
      palCrawler: {
        name: '국회 입법예고 크롤러',
        source: 'pal.assembly.go.kr',
        status: schedulerState.isProcessing
          ? ('running' as const)
          : palPhase?.status === 'failed'
            ? ('failed' as const)
            : ('idle' as const),
        lastRunAt:
          schedulerState.lastPalCronRunAt ?? palPhase?.lastRunAt ?? null,
        lastError: palPhase?.lastError ?? null,
        cron: {
          expression: palCron,
          ...resolveCronDisplay(palCron),
        },
      },
      nsmPendingCrawler: {
        name: '국민참여입법센터 크롤러',
        source: 'opinion.lawmaking.go.kr',
        status: schedulerState.isPendingProcessing
          ? ('running' as const)
          : pendingSyncPhase?.status === 'failed'
            ? ('failed' as const)
            : ('idle' as const),
        lastRunAt:
          schedulerState.lastNsmPendingCronRunAt ??
          pendingSyncPhase?.lastRunAt ??
          null,
        lastError: pendingSyncPhase?.lastError ?? null,
        cron: {
          expression: nsmCron,
          ...resolveCronDisplay(nsmCron),
        },
      },
      archiveSync: {
        isRunning: archiveState?.isAnyPhaseRunning ?? false,
        runningPhases: archiveState?.runningPhases ?? [],
        phases: (archiveState?.phases ?? []).map((p) => ({
          name: p.name,
          status: p.status,
          lastRunAt: p.lastRunAt,
          lastError: p.lastError,
        })),
        asyncApply: archiveState?.asyncApply ?? null,
      },
    };
  }
}
