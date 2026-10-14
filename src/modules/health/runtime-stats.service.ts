import {
  Injectable,
  Inject,
  OnModuleInit,
  OnModuleDestroy,
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
  isLikmsNsmSourceEnabled,
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
  [APP_CONSTANTS.CRON.EXPRESSIONS.WEB_PUSH_CLEANUP]: 3_600_000,
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

/**
 * Presentation metadata for the active NSM-shaped list/detail source.
 *
 * The NSM crawler can read either the public-participation portal
 * (`opinion.lawmaking.go.kr`, `NsmLmSts`) or the National Assembly Bill
 * Information System (`likms.assembly.go.kr`, `LikmsNsmAdapter`), selected by
 * `CRAWLING_NSM_SOURCE`. Resolved on every aggregation rather than at module
 * load, so an operator toggling the source is reported without a restart.
 */
function resolveNsmSourceInfo(): {
  source: string;
  name: string;
  url: string;
  description: string;
  crawlerName: string;
  scheduleName: string;
  scheduleDescription: string;
  transferFlowDescription: string;
} {
  if (isLikmsNsmSourceEnabled()) {
    return {
      source: 'likms.assembly.go.kr',
      name: '국회 의안정보시스템 계류의안',
      url: 'https://likms.assembly.go.kr',
      description: '국회 의안정보시스템의 계류의안 목록을 수집합니다.',
      crawlerName: '국회 의안정보시스템 계류의안 크롤러',
      scheduleName: '국회 의안정보시스템 계류의안 수집',
      scheduleDescription:
        '국회 의안정보시스템의 계류의안 목록을 주기적으로 수집합니다.',
      transferFlowDescription:
        '국회 의안정보시스템의 계류의안이 국회입법현황으로 이관되면, 크롤러가 이를 자동으로 감지하여 동기화합니다.',
    };
  }

  return {
    source: 'opinion.lawmaking.go.kr',
    name: '국민참여입법센터 입법진행현황',
    url: 'https://opinion.lawmaking.go.kr',
    description: '국민참여입법센터의 입법진행현황(국회입법현황)을 수집합니다.',
    crawlerName: '국민참여입법센터 입법진행현황 크롤러',
    scheduleName: '국민참여입법센터 입법진행현황 수집',
    scheduleDescription:
      '국민참여입법센터의 입법진행현황(국회입법현황)을 주기적으로 수집합니다.',
    transferFlowDescription:
      '국민참여입법센터의 입법진행현황에서 국회입법현황으로 이관된 의안이 있으면, 크롤러가 이를 자동으로 감지하여 동기화합니다.',
  };
}

@Injectable()
export class RuntimeStatsService implements OnModuleInit, OnModuleDestroy {
  private eventLoopStats: any = null;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly measurementInterval = 2000;

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
      changeTrackingService.getComparableChangeSummary(),
      webPushSubscriptionService.getStatsForApi(),
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
      aiSummaryEnabled: (await crawlingService.getOllamaMetrics()).enabled,
      nodeRuntime,
      crawlers: this.buildCrawlersStatus(
        crawlingService,
        archiveSyncService,
        cronJobsService,
        await this.readNsmListScanHealth(),
      ),
    };
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
  async getTransparencyStats() {
    // Return cached result if still fresh to avoid repeated DB aggregations.
    const cached = await this.cacheManager.get<Record<string, unknown>>(
      RuntimeStatsService.TRANSPARENCY_CACHE_KEY,
    );
    if (cached) return cached;

    // Run all independent DB aggregations in parallel to minimize latency.
    // Three queries target notice_archives, two target notice_change_events.
    const [archiveAgg, eventAgg] = await Promise.all([
      // ── Archive aggregation: total, PAL/NSM split, lifecycle breakdown ──
      (async () => {
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
            lifecycleRows.map((r) => [r.status, Number(r.count)]),
          ),
          palCount, // contentId NOT NULL = PAL-registered bills
          nsmCount: total - palCount, // contentId IS NULL = NSM-originated
        };
      })(),
      // ── Change event aggregation: type + source breakdown ──
      (async () => {
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
          total: typeRows.reduce((s, r) => s + Number(r.count), 0),
          byType: Object.fromEntries(
            typeRows.map((r) => [r.type, Number(r.count)]),
          ),
          bySource: Object.fromEntries(
            sourceRows.map((r) => [r.source ?? 'unknown', Number(r.count)]),
          ),
        };
      })(),
    ]);

    const palCron = APP_CONSTANTS.CRON.EXPRESSIONS.CRAWLING_CHECK;
    const nsmCron = APP_CONSTANTS.CRON.EXPRESSIONS.PENDING_CRAWLING_CHECK;
    const isDoneCron = APP_CONSTANTS.CRON.EXPRESSIONS.IS_DONE_SYNC;
    const nsmSource = resolveNsmSourceInfo();

    const result = {
      noticeSources: [
        {
          id: 'pal',
          name: '국회 입법예고 게시판',
          url: 'https://pal.assembly.go.kr',
          description: '국회에서 발의된 법률안과 입법예고 정보를 수집합니다.',
          noticeCount: archiveAgg.palCount,
          intervalMs: CRON_INTERVAL_MAP[palCron] ?? 0,
          intervalLabel: resolveCronDisplay(palCron).description,
        },
        {
          id: 'nsm',
          name: nsmSource.name,
          url: nsmSource.url,
          description: nsmSource.description,
          noticeCount: archiveAgg.nsmCount,
          intervalMs: CRON_INTERVAL_MAP[nsmCron] ?? 0,
          intervalLabel: resolveCronDisplay(nsmCron).description,
        },
      ],
      collection: {
        totalNotices: archiveAgg.total,
        byLifecycle: archiveAgg.byLifecycle,
        bySource: eventAgg.bySource,
      },
      changeTracking: {
        totalEvents: eventAgg.total,
        byType: eventAgg.byType,
      },
      schedules: [
        {
          id: 'pal-crawl',
          name: '국회 입법예고 수집',
          intervalMs: CRON_INTERVAL_MAP[palCron] ?? 0,
          intervalLabel: resolveCronDisplay(palCron).description,
          description:
            '국회 입법예고 게시판을 주기적으로 확인하여 신규·변경 의안을 감지합니다.',
        },
        {
          id: 'nsm-pending',
          name: nsmSource.scheduleName,
          intervalMs: CRON_INTERVAL_MAP[nsmCron] ?? 0,
          intervalLabel: resolveCronDisplay(nsmCron).description,
          description: nsmSource.scheduleDescription,
        },
        {
          id: 'isdone-sync',
          name: '입법예고 종료 확인',
          intervalMs: CRON_INTERVAL_MAP[isDoneCron] ?? 0,
          intervalLabel: resolveCronDisplay(isDoneCron).description,
          description:
            '입법예고 기간이 종료된 의안의 종료 여부를 동기화합니다.',
        },
      ],
      transferFlow: {
        description: nsmSource.transferFlowDescription,
        nsmToPalIndicator:
          '국회입법현황에서 의안으로 등록된 경우, 크롤러가 자동으로 동기화하여 관리합니다.',
      },
    } as const;

    await this.cacheManager.set(
      RuntimeStatsService.TRANSPARENCY_CACHE_KEY,
      result,
      RuntimeStatsService.TRANSPARENCY_CACHE_TTL_MS,
    );

    return result;
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
    archiveSyncService?: ArchiveSyncService,
    cronJobsService?: CronJobsService,
    nsmListScanHealth: NsmListScanHealth | null = null,
  ) {
    const schedulerState = crawlingService.getSchedulerExecutionState();
    const archiveState = archiveSyncService.getExecutionState();

    const palPhase = archiveState.phases.find((p) => p.name === 'full sync');
    const pendingSyncPhase = archiveState.phases.find(
      (p) => p.name === 'pending sync',
    );

    const palCron = APP_CONSTANTS.CRON.EXPRESSIONS.CRAWLING_CHECK;
    const nsmCron = APP_CONSTANTS.CRON.EXPRESSIONS.PENDING_CRAWLING_CHECK;

    // Read the runtime gates on every aggregation (not at module load) so the
    // status page reflects an operator toggling CRAWLING_PAL_ENABLED /
    // CRAWLING_NSM_ENABLED without a server restart.
    const palEnabled = isPalCrawlerEnabled();
    const nsmEnabled = isNsmCrawlerEnabled();
    const nsmSource = resolveNsmSourceInfo();

    return {
      palCrawler: {
        name: '국회 입법예고 크롤러',
        source: 'pal.assembly.go.kr',
        enabled: palEnabled,
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
        name: nsmSource.crawlerName,
        source: nsmSource.source,
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
        cron: {
          expression: nsmCron,
          ...resolveCronDisplay(nsmCron),
        },
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
          cron: expression
            ? { expression, ...resolveCronDisplay(expression) }
            : { expression: '', intervalMs: 0, description: '' },
        };
      }),
    };
  }
}
