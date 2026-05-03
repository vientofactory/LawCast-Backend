import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { WebhookService } from './webhook.service';
import { CrawlingService } from './crawling.service';
import { BatchProcessingService } from './batch-processing.service';
import { NoticeArchiveService } from './notice-archive.service';
import { IsDoneSyncService } from './is-done-sync.service';

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
    batchProcessingService: BatchProcessingService,
    noticeArchiveService: NoticeArchiveService,
    isDoneSyncService?: IsDoneSyncService,
  ) {
    const nodeEnv = params.nodeEnv;
    if (
      !webhookService ||
      !crawlingService ||
      !batchProcessingService ||
      !noticeArchiveService
    ) {
      throw new Error('All service dependencies must be provided');
    }
    const [webhookStats, cacheInfo, batchStatus, archiveCount, ollamaMetrics] =
      await Promise.all([
        webhookService.getDetailedStatsForApi({ nodeEnv }),
        crawlingService.getCacheInfo(),
        batchProcessingService.getBatchStatusForApi({ nodeEnv }),
        noticeArchiveService.getArchiveCount(),
        crawlingService.getOllamaMetrics(),
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
        isDoneSync: isDoneSyncService?.getSyncStatus() ?? null,
      },
      batchProcessing: batchStatus,
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
    };
  }

  getNodeRuntimeStats() {
    return {
      eventLoopDelay: this.eventLoopStats,
      memory: process.memoryUsage(),
    };
  }
}
