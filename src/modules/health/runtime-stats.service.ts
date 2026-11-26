import {
  Injectable,
  Inject,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WebhookService } from '../webhook/webhook.service';
import { CrawlingService } from '../crawling/crawling.service';
import { NoticeArchiveService } from '../notice/notice-archive.service';
import { ArchiveSyncService } from '../crawling/archive-sync.service';
import { ChangeTrackingService } from '../change-tracking/change-tracking.service';
import { WebPushSubscriptionService } from '../notification/web-push-subscription.service';
import { APP_CONSTANTS } from '../../config/app.config';
import {
  isNsmCrawlerEnabled,
  isPalCrawlerEnabled,
} from '../../utils/crawler-activation.utils';
import { NoticeArchive } from '../notice/notice-archive.entity';
import { NoticeChangeEvent } from '../change-tracking/notice-change-event.entity';
import type { CronJobsService } from '../scheduling/cronjobs.service';
import {
  describeNsmListScanHealth,
  readNsmListScanHealth,
  type NsmListScanHealth,
} from '../crawling/utils/nsm-list-scan-health.util';
import { getCronSchedule } from './cron-display.util';
import { resolveRuntimeCrawlerSources } from './crawler-source-presentation';
import type {
  ArchiveTransparencyTotals,
  ChangeEventTransparencyTotals,
  EventLoopDelayStats,
  TransparencyStats,
} from './runtime-stats.types';
import { StatsReadTrace } from './stats-read-trace';
import { getAiSummaryTransparencyInfo } from '../ollama/ai-summary-prompt.util';

@Injectable()
export class RuntimeStatsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RuntimeStatsService.name);
  private eventLoopStats: EventLoopDelayStats | null = null;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly measurementInterval = 2000;
  private transparencyInFlight: Promise<TransparencyStats> | null = null;

  private static readonly TRANSPARENCY_CACHE_KEY = 'transparency:stats';
  private static readonly TRANSPARENCY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    @InjectRepository(NoticeArchive)
    private readonly archiveRepo: Repository<NoticeArchive>,
    @InjectRepository(NoticeChangeEvent)
    private readonly changeEventRepo: Repository<NoticeChangeEvent>,
  ) {}

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

  async getHomeStats(
    crawlingService: CrawlingService,
    noticeArchiveService: NoticeArchiveService,
    changeTrackingService: ChangeTrackingService,
    aiSummaryEnabled: boolean,
  ) {
    return this.traceRead('home', async (trace) => {
      const [cache, count, changes] = await Promise.all([
        trace.measure('cache', () => crawlingService.getCacheInfo()),
        trace.measure('archiveCount', () =>
          noticeArchiveService.getArchiveCount(),
        ),
        trace.measure('changeSummary', () =>
          changeTrackingService.getComparableChangeSummary(),
        ),
      ]);
      return {
        archive: { count },
        cache: { lastUpdated: cache.lastUpdated },
        changeTracking: { comparableEventTotal: changes.comparableEventTotal },
        aiSummaryEnabled,
      };
    });
  }

  async getAggregatedStats(
    params: { nodeEnv?: string },
    webhookService: WebhookService,
    crawlingService: CrawlingService,
    noticeArchiveService: NoticeArchiveService,
    archiveSyncService: ArchiveSyncService,
    changeTrackingService: ChangeTrackingService,
    webPushSubscriptionService: WebPushSubscriptionService,
    cronJobsService: CronJobsService,
  ) {
    return this.traceRead(
      'full',
      async (trace) => {
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
          trace.measure('webhooks', () =>
            webhookService.getDetailedStatsForApi({ nodeEnv }),
          ),
          trace.measure('cache', () => crawlingService.getCacheInfo()),
          trace.measure('archiveCount', () =>
            noticeArchiveService.getArchiveCount(),
          ),
          trace.measure('ollama', () => crawlingService.getOllamaMetrics()),
          trace.measure('changeSummary', () =>
            changeTrackingService.getComparableChangeSummary(),
          ),
          trace.measure('webPush', () =>
            webPushSubscriptionService.getStatsForApi(),
          ),
        ]);
        const nodeRuntime = this.getNodeRuntimeStats();
        const isProduction = nodeEnv === 'production';
        const nsmHealth = await trace.measure('nsmHealth', () =>
          this.readNsmListScanHealth(),
        );
        const crawlers = await trace.measure('crawlerPresentation', () =>
          this.buildCrawlersStatus(
            crawlingService,
            archiveSyncService,
            cronJobsService,
            nsmHealth,
          ),
        );
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
            isDoneSync: archiveSyncService.getIsDoneSyncStatus(),
            legacyGenesisSeed: archiveSyncService.getLegacyGenesisSeedStatus(),
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
          aiSummaryEnabled: ollamaMetrics.enabled,
          nodeRuntime,
          crawlers,
        };
      },
      () => {
        const scheduler = crawlingService.getSchedulerExecutionState();
        const archive = archiveSyncService.getExecutionState();
        return {
          palRunning: scheduler.isProcessing,
          nsmRunning: scheduler.isPendingProcessing,
          archivePhases: archive.runningPhases,
          loopWindowMaxMs: this.eventLoopStats?.max ?? null,
        };
      },
    );
  }

  /**
   * Reads the NSM list-scan health record written by the crawl paths.
   *
   * `null` means "nothing recorded yet" (fresh install, flushed cache) and is
   * reported as unknown rather than healthy. A read failure must not break the
   * status endpoint, so it degrades to the same unknown state.
   */
  private async readNsmListScanHealth(): Promise<NsmListScanHealth | null> {
    try {
      return await readNsmListScanHealth({
        getObject: async <T>(key: string) =>
          (await this.cacheManager.get<T>(key)) ?? null,
      });
    } catch {
      return null;
    }
  }

  private async traceRead<T>(
    view: 'full' | 'home',
    work: (trace: StatsReadTrace) => Promise<T>,
    context?: () => Record<string, unknown>,
  ): Promise<T> {
    const trace = new StatsReadTrace(view, (row) =>
      this.logger.warn(JSON.stringify({ ...row, background: context?.() })),
    );
    try {
      const value = await work(trace);
      trace.finish();
      return value;
    } catch (error) {
      trace.finish(true);
      throw error;
    }
  }

  getNodeRuntimeStats() {
    return {
      eventLoopDelay: this.eventLoopStats,
      memory: process.memoryUsage(),
    };
  }

  /**
   * Returns aggregated statistics for the crawling transparency page.
   * Includes source breakdowns, lifecycle counts, change event stats,
   * and crawler schedule information.
   */
  async getTransparencyStats(): Promise<TransparencyStats> {
    if (this.transparencyInFlight) return this.transparencyInFlight;
    const pending = this.readCachedTransparencyStats();
    this.transparencyInFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.transparencyInFlight === pending)
        this.transparencyInFlight = null;
    }
  }

  private async readCachedTransparencyStats(): Promise<TransparencyStats> {
    // Return cached result if still fresh to avoid repeated DB aggregations.
    const cached = await this.cacheManager.get<TransparencyStats>(
      RuntimeStatsService.TRANSPARENCY_CACHE_KEY,
    );
    if (cached) return cached;

    const [archiveTotals, eventTotals] = await Promise.all([
      this.readArchiveTransparencyTotals(),
      this.readChangeEventTransparencyTotals(),
    ]);
    const result = this.buildTransparencyStats(archiveTotals, eventTotals);

    await this.cacheManager.set(
      RuntimeStatsService.TRANSPARENCY_CACHE_KEY,
      result,
      RuntimeStatsService.TRANSPARENCY_CACHE_TTL_MS,
    );

    return result;
  }

  private async readArchiveTransparencyTotals(): Promise<ArchiveTransparencyTotals> {
    const [total, lifecycleRows, palCount] = await Promise.all([
      this.archiveRepo.count(),
      this.archiveRepo
        .createQueryBuilder('a')
        .select('a.lifecycle_status', 'status')
        .addSelect('COUNT(*)', 'count')
        .groupBy('a.lifecycle_status')
        .getRawMany<{ status: string; count: string }>(),
      this.archiveRepo
        .createQueryBuilder('a')
        .where('a.contentId IS NOT NULL')
        .getCount(),
    ]);
    return {
      total,
      byLifecycle: Object.fromEntries(
        lifecycleRows.map((row) => [row.status, Number(row.count)]),
      ),
      palCount,
      nsmCount: total - palCount,
    };
  }

  private async readChangeEventTransparencyTotals(): Promise<ChangeEventTransparencyTotals> {
    const [typeRows, sourceRows] = await Promise.all([
      this.changeEventRepo
        .createQueryBuilder('e')
        .select('e.event_type', 'type')
        .addSelect('COUNT(*)', 'count')
        .groupBy('e.event_type')
        .getRawMany<{ type: string; count: string }>(),
      this.changeEventRepo
        .createQueryBuilder('e')
        .select('e.source', 'source')
        .addSelect('COUNT(*)', 'count')
        .groupBy('e.source')
        .getRawMany<{ source: string; count: string }>(),
    ]);
    return {
      total: typeRows.reduce((total, row) => total + Number(row.count), 0),
      byType: Object.fromEntries(
        typeRows.map((row) => [row.type, Number(row.count)]),
      ),
      bySource: Object.fromEntries(
        sourceRows.map((row) => [row.source ?? 'unknown', Number(row.count)]),
      ),
    };
  }

  private buildTransparencyStats(
    archive: ArchiveTransparencyTotals,
    events: ChangeEventTransparencyTotals,
  ): TransparencyStats {
    const { pal, nsm } = resolveRuntimeCrawlerSources();
    const sources = [pal, nsm];
    const sourceCounts = { pal: archive.palCount, nsm: archive.nsmCount };
    const schedules = [
      pal.schedule,
      nsm.schedule,
      {
        id: 'isdone-sync',
        name: '입법예고 종료 확인',
        expression: APP_CONSTANTS.CRON.EXPRESSIONS.IS_DONE_SYNC,
        description: '입법예고 기간이 종료된 의안의 종료 여부를 동기화합니다.',
      },
    ];
    return {
      noticeSources: sources.map((source) => {
        const cron = getCronSchedule(source.schedule.expression);
        return {
          id: source.id,
          name: source.name,
          url: source.url,
          description: source.description,
          noticeCount: sourceCounts[source.id],
          intervalMs: cron.intervalMs,
          intervalLabel: cron.description,
        };
      }),
      collection: {
        totalNotices: archive.total,
        byLifecycle: archive.byLifecycle,
        bySource: events.bySource,
      },
      changeTracking: { totalEvents: events.total, byType: events.byType },
      schedules: schedules.map((schedule) => {
        const cron = getCronSchedule(schedule.expression);
        return {
          id: schedule.id,
          name: schedule.name,
          intervalMs: cron.intervalMs,
          intervalLabel: cron.description,
          description: schedule.description,
        };
      }),
      transferFlow: {
        description: nsm.transferFlowDescription,
        nsmToPalIndicator:
          '국회입법현황에서 의안으로 등록된 경우, 크롤러가 자동으로 동기화하여 관리합니다.',
      },
      aiSummary: getAiSummaryTransparencyInfo(),
    };
  }

  /**
   * Reports the NSM list scan as the status API sees it.
   *
   * `degraded` means every completed list scan in a row returned zero rows, so
   * the collector is not reading a list at all — the state that a silent "no new
   * notices" used to hide. `staleHours` counts from the last scan that returned
   * rows, which is the earliest signal of a stall even before the threshold is
   * crossed.
   */
  private buildNsmListScanStatus(health: NsmListScanHealth | null, now: Date) {
    const { staleHours, lastSuccessfulScanAgoLabel } =
      describeNsmListScanHealth(health, now);

    return {
      degraded: health?.degraded ?? false,
      consecutiveZeroRowScans: health?.consecutiveZeroRowScans ?? 0,
      lastScanAt: health?.lastScanAt ?? null,
      lastScanItemCount: health?.lastScanItemCount ?? null,
      lastSuccessfulScanAt: health?.lastSuccessfulScanAt ?? null,
      lastSuccessfulScanItemCount: health?.lastSuccessfulScanItemCount ?? null,
      degradedSince: health?.degradedSince ?? null,
      staleHours,
      description: lastSuccessfulScanAgoLabel,
    };
  }

  private buildCrawlersStatus(
    crawlingService: CrawlingService,
    archiveSyncService: ArchiveSyncService,
    cronJobsService: CronJobsService,
    nsmListScanHealth: NsmListScanHealth | null = null,
  ) {
    const schedulerState = crawlingService.getSchedulerExecutionState();
    const archiveState = archiveSyncService.getExecutionState();

    const palPhase = archiveState.phases.find((p) => p.name === 'full sync');
    const pendingSyncPhase = archiveState.phases.find(
      (p) => p.name === 'pending sync',
    );

    const { pal, nsm } = resolveRuntimeCrawlerSources();

    // Read the runtime gates on every aggregation (not at module load) so the
    // status page reflects an operator toggling CRAWLING_PAL_ENABLED /
    // CRAWLING_NSM_ENABLED without a server restart.
    const palEnabled = isPalCrawlerEnabled();
    const nsmEnabled = isNsmCrawlerEnabled();

    return {
      palCrawler: {
        name: pal.name,
        source: pal.source,
        enabled: palEnabled,
        status: schedulerState.isProcessing
          ? ('running' as const)
          : palPhase?.status === 'failed'
            ? ('failed' as const)
            : ('idle' as const),
        lastRunAt:
          schedulerState.lastPalCronRunAt ?? palPhase?.lastRunAt ?? null,
        lastError: palPhase?.lastError ?? null,
        cron: getCronSchedule(pal.schedule.expression),
      },
      nsmPendingCrawler: {
        name: nsm.name,
        source: nsm.source,
        enabled: nsmEnabled,
        // `degraded` outranks a stale `failed` phase: a run that completed while
        // reading nothing is the state an operator has to act on first.
        status: schedulerState.isPendingProcessing
          ? ('running' as const)
          : nsmListScanHealth?.degraded
            ? ('degraded' as const)
            : pendingSyncPhase?.status === 'failed'
              ? ('failed' as const)
              : ('idle' as const),
        lastRunAt:
          schedulerState.lastNsmPendingCronRunAt ??
          pendingSyncPhase?.lastRunAt ??
          null,
        lastError: pendingSyncPhase?.lastError ?? null,
        listScan: this.buildNsmListScanStatus(nsmListScanHealth, new Date()),
        cron: getCronSchedule(nsm.schedule.expression),
      },
      archiveSync: {
        isRunning: archiveState.isAnyPhaseRunning,
        runningPhases: archiveState.runningPhases,
        phases: archiveState.phases.map((p) => ({
          name: p.name,
          status: p.status,
          lastRunAt: p.lastRunAt,
          lastError: p.lastError,
        })),
        asyncApply: archiveState.asyncApply,
      },
      cronJobs: cronJobsService.getCronJobsStatus().map((job) => {
        const expression = cronJobsService.getCronJobExpression(job.taskName);
        return {
          name: job.taskName,
          status: job.status,
          lastRunAt: job.lastRunAt,
          lastError: job.lastError,
          cron: getCronSchedule(expression),
        };
      }),
    };
  }
}
