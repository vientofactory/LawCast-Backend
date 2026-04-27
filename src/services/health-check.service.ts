import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from './cache.service';
import {
  OllamaClientService,
  type OllamaRuntimeMetrics,
} from '../modules/ollama/ollama-client.service';

@Injectable()
export class HealthCheckService {
  private readonly logger = new Logger(HealthCheckService.name);
  private ollamaMetricsCache: OllamaRuntimeMetrics | null = null;
  private ollamaMetricsCacheAt: number | null = null;
  private readonly ollamaMetricsCacheTtlMs = 30000;

  constructor(
    private cacheService: CacheService,
    private ollamaClientService: OllamaClientService,
  ) {}

  async getApiHealthPayload(params: { nodeEnv?: string }) {
    const nodeEnv = params.nodeEnv;
    const [isRedisConnected, cacheInfo, ollamaMetrics] = await Promise.all([
      this.cacheService.isRedisConnected(),
      this.cacheService.getCacheInfo(),
      this.getOllamaMetrics(),
    ]);
    const isProduction = nodeEnv === 'production';
    const isOllamaDegraded =
      ollamaMetrics.enabled &&
      (ollamaMetrics.health.status === 'unhealthy' ||
        ollamaMetrics.health.status === 'misconfigured');
    const systemStatus =
      isRedisConnected && !isOllamaDegraded ? 'healthy' : 'degraded';
    if (isProduction) {
      return {
        timestamp: new Date().toISOString(),
        status: systemStatus,
        dependencies: {
          redis: isRedisConnected ? 'up' : 'down',
          ollama: ollamaMetrics.health.status,
        },
      };
    }
    return {
      timestamp: new Date().toISOString(),
      status: systemStatus,
      redis: {
        connected: isRedisConnected,
        cache: cacheInfo,
      },
      ollama: ollamaMetrics,
    };
  }

  async getRedisStatusForApi(params: { nodeEnv?: string }) {
    const nodeEnv = params.nodeEnv;
    const redisStatus = await this.cacheService.getRedisStatus();
    const isProduction = nodeEnv === 'production';
    if (isProduction) {
      return {
        data: {
          connected: redisStatus.connected,
          timestamp: new Date().toISOString(),
        },
        message: redisStatus.connected
          ? 'Redis status is available'
          : 'Redis is unavailable',
      };
    }
    const message = redisStatus.connected
      ? `Redis is connected (${redisStatus.responseTime}ms response time)`
      : `Redis connection failed: ${redisStatus.error}`;
    return { data: redisStatus, message };
  }

  async getOllamaMetrics(
    options: { forceHealthCheck?: boolean } = {},
  ): Promise<OllamaRuntimeMetrics> {
    const now = Date.now();
    const force = options.forceHealthCheck ?? false;
    if (
      !force &&
      this.ollamaMetricsCache &&
      this.ollamaMetricsCacheAt &&
      now - this.ollamaMetricsCacheAt < this.ollamaMetricsCacheTtlMs
    ) {
      return this.ollamaMetricsCache;
    }
    const metrics = await this.ollamaClientService.getMetrics(options);
    this.ollamaMetricsCache = metrics;
    this.ollamaMetricsCacheAt = now;
    return metrics;
  }
}
