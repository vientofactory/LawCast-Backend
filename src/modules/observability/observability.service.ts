import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { SpanStoreService } from './span-store.service';
import { LogBufferService, OtelSeverityNumber } from './log-buffer.service';

// ---------------------------------------------------------------------------
// OTLP-compatible types
// ---------------------------------------------------------------------------

export interface OtelResource {
  attributes: Record<string, { stringValue: string }>;
}

export interface OtelScope {
  name: string;
  version: string;
}

export interface OtelMetricPoint {
  attributes: Record<string, { stringValue: string }>;
  startTimeUnixNano: string;
  timeUnixNano: string;
  asInt?: string;
  asDouble?: number;
}

export interface OtelGauge {
  dataPoints: OtelMetricPoint[];
}

export interface OtelSum {
  dataPoints: OtelMetricPoint[];
  aggregationTemporality: number;
  isMonotonic: boolean;
}

export interface OtelHistogram {
  dataPoints: Array<{
    attributes: Record<string, { stringValue: string }>;
    startTimeUnixNano: string;
    timeUnixNano: string;
    count: string;
    sum: number;
    bucketCounts: string[];
    explicitBounds: number[];
  }>;
  aggregationTemporality: number;
}

export interface OtelMetric {
  name: string;
  description: string;
  unit: string;
  gauge?: OtelGauge;
  sum?: OtelSum;
  histogram?: OtelHistogram;
}

export interface OtelMetricsScopeMetrics {
  scope: OtelScope;
  metrics: OtelMetric[];
}

export interface OtelMetricsPayload {
  resource: OtelResource;
  scopeMetrics: OtelMetricsScopeMetrics[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class ObservabilityService implements OnModuleInit, OnModuleDestroy {
  private eventLoopHistogram: ReturnType<typeof monitorEventLoopDelay> | null =
    null;
  private eventLoopInterval: NodeJS.Timeout | null = null;
  private readonly serviceName: string;
  private readonly serviceVersion: string;
  private readonly startTimeNano: string;
  private prevCpuUser = 0;
  private prevCpuSystem = 0;
  private prevHrTime: [number, number] = process.hrtime();

  constructor(
    private readonly spanStore: SpanStoreService,
    private readonly logBuffer: LogBufferService,
  ) {
    this.serviceName = process.env.SERVICE_NAME ?? 'lawcast-backend';
    this.serviceVersion = process.env.SERVICE_VERSION ?? '0.0.0';
    this.startTimeNano = process.hrtime.bigint().toString();
  }

  onModuleInit() {
    this.startEventLoopMonitor();
    this.logBuffer.push(
      OtelSeverityNumber.INFO,
      'ObservabilityService started',
      { service: 'observability' },
    );
  }

  onModuleDestroy() {
    this.stopEventLoopMonitor();
  }

  // -------------------------------------------------------------------------
  // Event-loop delay histogram
  // -------------------------------------------------------------------------

  private startEventLoopMonitor() {
    this.eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoopHistogram.enable();
    this.eventLoopInterval = setInterval(() => {
      // Reset is handled implicitly by reading
    }, 5000);
  }

  private stopEventLoopMonitor() {
    if (this.eventLoopInterval) {
      clearInterval(this.eventLoopInterval);
      this.eventLoopInterval = null;
    }
    if (this.eventLoopHistogram) {
      this.eventLoopHistogram.disable();
      this.eventLoopHistogram = null;
    }
  }

  // -------------------------------------------------------------------------
  // Resource info
  // -------------------------------------------------------------------------

  private getResource(): OtelResource {
    return {
      attributes: {
        'service.name': { stringValue: this.serviceName },
        'service.version': { stringValue: this.serviceVersion },
        'service.namespace': { stringValue: 'lawcast' },
        'host.name': { stringValue: os.hostname() },
        'os.type': { stringValue: process.platform },
        'os.description': { stringValue: process.version },
        'process.pid': { stringValue: String(process.pid) },
        'process.executable.name': {
          stringValue: process.argv?.[0] ?? 'node',
        },
        'deployment.environment': {
          stringValue: process.env.NODE_ENV ?? 'development',
        },
      },
    };
  }

  // -------------------------------------------------------------------------
  // Metrics collection
  // -------------------------------------------------------------------------

  private collectMetrics(): OtelMetricsPayload {
    const now = process.hrtime.bigint().toString();
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const uptimeSec = process.uptime();

    const cpuUserDelta = cpu.user - this.prevCpuUser;
    const cpuSystemDelta = cpu.system - this.prevCpuSystem;
    this.prevCpuUser = cpu.user;
    this.prevCpuSystem = cpu.system;

    const hrDelta = process.hrtime(this.prevHrTime);
    this.prevHrTime = process.hrtime();

    // Convert HRTime bigint to a usable number for cpu percentage
    const elapsedNano = Number(hrDelta[0]) * 1e9 + Number(hrDelta[1]);
    const cpuUserPercent =
      elapsedNano > 0 ? (cpuUserDelta / elapsedNano) * 100 : 0;
    const cpuSystemPercent =
      elapsedNano > 0 ? (cpuSystemDelta / elapsedNano) * 100 : 0;

    // Event loop delay
    const elh = this.eventLoopHistogram;
    const eventLoopMetrics: OtelMetric[] = [];

    if (elh) {
      eventLoopMetrics.push(
        {
          name: 'event_loop_delay_min',
          description: 'Minimum event loop delay in ms',
          unit: 'ms',
          gauge: {
            dataPoints: [
              {
                attributes: {},
                startTimeUnixNano: this.startTimeNano,
                timeUnixNano: now,
                asDouble: Math.round(elh.min / 1e6),
              },
            ],
          },
        },
        {
          name: 'event_loop_delay_max',
          description: 'Maximum event loop delay in ms',
          unit: 'ms',
          gauge: {
            dataPoints: [
              {
                attributes: {},
                startTimeUnixNano: this.startTimeNano,
                timeUnixNano: now,
                asDouble: Math.round(elh.max / 1e6),
              },
            ],
          },
        },
        {
          name: 'event_loop_delay_mean',
          description: 'Mean event loop delay in ms',
          unit: 'ms',
          gauge: {
            dataPoints: [
              {
                attributes: {},
                startTimeUnixNano: this.startTimeNano,
                timeUnixNano: now,
                asDouble: Math.round(elh.mean / 1e6),
              },
            ],
          },
        },
        {
          name: 'event_loop_delay_p50',
          description: 'P50 event loop delay in ms',
          unit: 'ms',
          gauge: {
            dataPoints: [
              {
                attributes: {},
                startTimeUnixNano: this.startTimeNano,
                timeUnixNano: now,
                asDouble: Math.round(elh.percentile(50) / 1e6),
              },
            ],
          },
        },
        {
          name: 'event_loop_delay_p90',
          description: 'P90 event loop delay in ms',
          unit: 'ms',
          gauge: {
            dataPoints: [
              {
                attributes: {},
                startTimeUnixNano: this.startTimeNano,
                timeUnixNano: now,
                asDouble: Math.round(elh.percentile(90) / 1e6),
              },
            ],
          },
        },
        {
          name: 'event_loop_delay_p99',
          description: 'P99 event loop delay in ms',
          unit: 'ms',
          gauge: {
            dataPoints: [
              {
                attributes: {},
                startTimeUnixNano: this.startTimeNano,
                timeUnixNano: now,
                asDouble: Math.round(elh.percentile(99) / 1e6),
              },
            ],
          },
        },
        {
          name: 'event_loop_delay_exceeds',
          description:
            'Number of event loop iterations that exceeded delay threshold',
          unit: '1',
          sum: {
            dataPoints: [
              {
                attributes: {},
                startTimeUnixNano: this.startTimeNano,
                timeUnixNano: now,
                asInt: String(elh.exceeds),
              },
            ],
            aggregationTemporality: 2, // CUMULATIVE
            isMonotonic: true,
          },
        },
      );
      elh.reset();
    }

    const metrics: OtelMetric[] = [
      // Memory
      {
        name: 'process_runtime_heap_bytes',
        description: 'Process heap size in bytes',
        unit: 'bytes',
        gauge: {
          dataPoints: [
            {
              attributes: {},
              startTimeUnixNano: this.startTimeNano,
              timeUnixNano: now,
              asInt: String(mem.heapUsed),
            },
          ],
        },
      },
      {
        name: 'process_runtime_heap_total_bytes',
        description: 'Process total heap size in bytes',
        unit: 'bytes',
        gauge: {
          dataPoints: [
            {
              attributes: {},
              startTimeUnixNano: this.startTimeNano,
              timeUnixNano: now,
              asInt: String(mem.heapTotal),
            },
          ],
        },
      },
      {
        name: 'process_runtime_rss_bytes',
        description: 'Resident Set Size in bytes',
        unit: 'bytes',
        gauge: {
          dataPoints: [
            {
              attributes: {},
              startTimeUnixNano: this.startTimeNano,
              timeUnixNano: now,
              asInt: String(mem.rss),
            },
          ],
        },
      },
      {
        name: 'process_runtime_external_bytes',
        description: 'External memory in bytes',
        unit: 'bytes',
        gauge: {
          dataPoints: [
            {
              attributes: {},
              startTimeUnixNano: this.startTimeNano,
              timeUnixNano: now,
              asInt: String(mem.external),
            },
          ],
        },
      },
      // CPU
      {
        name: 'process_cpu_user',
        description: 'Total user CPU time in microseconds',
        unit: 'us',
        sum: {
          dataPoints: [
            {
              attributes: {},
              startTimeUnixNano: this.startTimeNano,
              timeUnixNano: now,
              asInt: String(cpu.user),
            },
          ],
          aggregationTemporality: 2,
          isMonotonic: true,
        },
      },
      {
        name: 'process_cpu_system',
        description: 'Total system CPU time in microseconds',
        unit: 'us',
        sum: {
          dataPoints: [
            {
              attributes: {},
              startTimeUnixNano: this.startTimeNano,
              timeUnixNano: now,
              asInt: String(cpu.system),
            },
          ],
          aggregationTemporality: 2,
          isMonotonic: true,
        },
      },
      {
        name: 'process_cpu_user_percent',
        description: 'User CPU usage percentage (delta)',
        unit: 'percent',
        gauge: {
          dataPoints: [
            {
              attributes: {},
              startTimeUnixNano: this.startTimeNano,
              timeUnixNano: now,
              asDouble: Math.round(cpuUserPercent * 100) / 100,
            },
          ],
        },
      },
      {
        name: 'process_cpu_system_percent',
        description: 'System CPU usage percentage (delta)',
        unit: 'percent',
        gauge: {
          dataPoints: [
            {
              attributes: {},
              startTimeUnixNano: this.startTimeNano,
              timeUnixNano: now,
              asDouble: Math.round(cpuSystemPercent * 100) / 100,
            },
          ],
        },
      },
      // Uptime
      {
        name: 'process_uptime',
        description: 'Process uptime in seconds',
        unit: 's',
        gauge: {
          dataPoints: [
            {
              attributes: {},
              startTimeUnixNano: this.startTimeNano,
              timeUnixNano: now,
              asDouble: Math.round(uptimeSec * 100) / 100,
            },
          ],
        },
      },
      // Active handles / requests
      {
        name: 'process_active_handles',
        description: 'Number of active libuv handles',
        unit: '1',
        gauge: {
          dataPoints: [
            {
              attributes: {},
              startTimeUnixNano: this.startTimeNano,
              timeUnixNano: now,
              asInt: String(
                (process as any)._getActiveHandles?.()?.length ?? 0,
              ),
            },
          ],
        },
      },
      {
        name: 'process_active_requests',
        description: 'Number of active libuv requests',
        unit: '1',
        gauge: {
          dataPoints: [
            {
              attributes: {},
              startTimeUnixNano: this.startTimeNano,
              timeUnixNano: now,
              asInt: String(
                (process as any)._getActiveRequests?.()?.length ?? 0,
              ),
            },
          ],
        },
      },
      // Span stats
      {
        name: 'traces_active_count',
        description: 'Number of currently active spans',
        unit: '1',
        gauge: {
          dataPoints: [
            {
              attributes: {},
              startTimeUnixNano: this.startTimeNano,
              timeUnixNano: now,
              asInt: String(this.spanStore.getStats().activeSpanCount),
            },
          ],
        },
      },
      {
        name: 'traces_completed_total',
        description: 'Total number of completed spans in buffer',
        unit: '1',
        gauge: {
          dataPoints: [
            {
              attributes: {},
              startTimeUnixNano: this.startTimeNano,
              timeUnixNano: now,
              asInt: String(this.spanStore.getStats().completedSpanCount),
            },
          ],
        },
      },
    ];

    // Event loop metrics are merged in
    metrics.push(...eventLoopMetrics);

    return {
      resource: this.getResource(),
      scopeMetrics: [
        {
          scope: {
            name: 'lawcast-observability',
            version: this.serviceVersion,
          },
          metrics,
        },
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Return the full observability payload in OpenTelemetry-compatible format.
   */
  getPayload(options?: { includeSpans?: boolean; includeLogs?: boolean }) {
    const includeSpans = options?.includeSpans ?? true;
    const includeLogs = options?.includeLogs ?? true;

    const result: Record<string, any> = {
      resource: this.getResource(),
      metrics: this.collectMetrics(),
      timestamp: new Date().toISOString(),
    };

    if (includeSpans) {
      const allSpans = this.spanStore.getAllSpans();
      result.traces = {
        resourceSpans: [
          {
            resource: this.getResource(),
            scopeSpans: [
              {
                scope: {
                  name: 'lawcast-observability',
                  version: this.serviceVersion,
                },
                spans: allSpans.completed,
              },
            ],
          },
        ],
        activeSpans: allSpans.active,
        stats: this.spanStore.getStats(),
      };
    }

    if (includeLogs) {
      result.logs = {
        resourceLogs: [
          {
            resource: this.getResource(),
            scopeLogs: [
              {
                scope: {
                  name: 'lawcast-observability',
                  version: this.serviceVersion,
                },
                logRecords: this.logBuffer.getRecords(),
              },
            ],
          },
        ],
        stats: this.logBuffer.getStats(),
      };
    }

    return result;
  }

  /**
   * Return only the metrics payload (for /metrics style endpoints).
   */
  getMetricsOnly(): OtelMetricsPayload {
    return this.collectMetrics();
  }

  /**
   * Push a custom log record into the buffer.
   */
  pushLog(
    severity: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: string,
    attributes: Record<string, string> = {},
  ): void {
    const severityMap: Record<string, OtelSeverityNumber> = {
      trace: OtelSeverityNumber.TRACE,
      debug: OtelSeverityNumber.DEBUG,
      info: OtelSeverityNumber.INFO,
      warn: OtelSeverityNumber.WARN,
      error: OtelSeverityNumber.ERROR,
      fatal: OtelSeverityNumber.FATAL,
    };
    this.logBuffer.push(
      severityMap[severity] ?? OtelSeverityNumber.INFO,
      message,
      attributes,
    );
  }

  /**
   * Clear the log buffer.
   */
  clearLogs(): void {
    this.logBuffer.clear();
  }
}
