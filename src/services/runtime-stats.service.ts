import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';

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

  getNodeRuntimeStats() {
    return {
      eventLoopDelay: this.eventLoopStats,
      memory: process.memoryUsage(),
    };
  }
}
