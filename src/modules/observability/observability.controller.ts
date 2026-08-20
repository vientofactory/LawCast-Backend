import {
  Controller,
  Get,
  Post,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiResponseUtils } from '../../utils/api-response.utils';
import { ObservabilityService } from './observability.service';
import { SpanStoreService } from './span-store.service';
import { LogBufferService, OtelSeverityNumber } from './log-buffer.service';

@Controller('api/observability')
export class ObservabilityController {
  constructor(
    private readonly observabilityService: ObservabilityService,
    private readonly spanStore: SpanStoreService,
    private readonly logBuffer: LogBufferService,
  ) {}

  /**
   * GET /api/observability
   *
   * Full observability payload: resource info, metrics, traces (active + recent),
   * and recent log records — all in OpenTelemetry-compatible JSON format.
   *
   * Query params:
   *   - spans=false   — exclude trace/span data
   *   - logs=false    — exclude log data
   *   - metrics=false — exclude metrics data
   */
  @Get()
  getObservabilityPayload(
    @Query('spans') spansRaw?: string,
    @Query('logs') logsRaw?: string,
    @Query('metrics') metricsRaw?: string,
  ) {
    const includeSpans = spansRaw !== 'false';
    const includeLogs = logsRaw !== 'false';
    const includeMetrics = metricsRaw !== 'false';

    const payload = this.observabilityService.getPayload({
      includeSpans,
      includeLogs,
    });

    if (!includeMetrics) {
      delete payload.metrics;
    }

    return ApiResponseUtils.success(
      payload,
      'OpenTelemetry observability data',
    );
  }

  /**
   * GET /api/observability/metrics
   *
   * Metrics-only endpoint following OTLP MetricsExportService pattern.
   * Returns process runtime metrics, event loop stats, CPU, memory, etc.
   */
  @Get('metrics')
  getMetrics() {
    const metrics = this.observabilityService.getMetricsOnly();
    return ApiResponseUtils.success(metrics, 'OpenTelemetry metrics');
  }

  /**
   * GET /api/observability/traces
   *
   * Traces endpoint: active spans + recently completed spans.
   * Follows OTLP TraceService pattern.
   */
  @Get('traces')
  getTraces(@Query('limit') limitRaw?: string) {
    const limit = limitRaw ? parseInt(limitRaw, 10) : 50;
    const allSpans = this.spanStore.getAllSpans();

    return ApiResponseUtils.success(
      {
        resourceSpans: [
          {
            resource: {
              attributes: {
                'service.name': {
                  stringValue: process.env.SERVICE_NAME ?? 'lawcast-backend',
                },
              },
            },
            scopeSpans: [
              {
                scope: {
                  name: 'lawcast-observability',
                  version: process.env.SERVICE_VERSION ?? '0.0.0',
                },
                spans: allSpans.completed.slice(-limit),
              },
            ],
          },
        ],
        activeSpans: allSpans.active,
        stats: this.spanStore.getStats(),
      },
      'OpenTelemetry traces',
    );
  }

  /**
   * GET /api/observability/logs
   *
   * Logs endpoint following OTLP LogExportService pattern.
   * Returns recent structured log records with OTel severity levels.
   *
   * Query params:
   *   - severity=INFO — minimum severity filter (TRACE|DEBUG|INFO|WARN|ERROR|FATAL)
   *   - limit=100     — max records to return
   */
  @Get('logs')
  getLogs(
    @Query('severity') severityRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? parseInt(limitRaw, 10) : 100;
    const severityMap: Record<string, OtelSeverityNumber> = {
      TRACE: OtelSeverityNumber.TRACE,
      DEBUG: OtelSeverityNumber.DEBUG,
      INFO: OtelSeverityNumber.INFO,
      WARN: OtelSeverityNumber.WARN,
      ERROR: OtelSeverityNumber.ERROR,
      FATAL: OtelSeverityNumber.FATAL,
    };

    const minSeverity =
      severityRaw && severityMap[severityRaw.toUpperCase()]
        ? severityMap[severityRaw.toUpperCase()]
        : OtelSeverityNumber.TRACE;

    const records = this.logBuffer
      .getRecordsBySeverity(minSeverity)
      .slice(-limit);

    return ApiResponseUtils.success(
      {
        resourceLogs: [
          {
            resource: {
              attributes: {
                'service.name': {
                  stringValue: process.env.SERVICE_NAME ?? 'lawcast-backend',
                },
              },
            },
            scopeLogs: [
              {
                scope: {
                  name: 'lawcast-observability',
                  version: process.env.SERVICE_VERSION ?? '0.0.0',
                },
                logRecords: records,
              },
            ],
          },
        ],
        stats: this.logBuffer.getStats(),
      },
      'OpenTelemetry logs',
    );
  }

  /**
   * POST /api/observability/logs
   *
   * Push a custom log entry into the observability buffer.
   *
   * Body (JSON):
   *   { "severity": "info", "message": "...", "attributes": { "key": "value" } }
   */
  @Post('logs')
  @HttpCode(HttpStatus.CREATED)
  pushLog(
    @Query('severity') severityRaw?: string,
    @Query('message') message?: string,
  ) {
    const severity = (severityRaw ?? 'info').toLowerCase();
    const validSeverities = [
      'trace',
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
    ];
    const severityParam = validSeverities.includes(severity)
      ? severity
      : 'info';

    this.observabilityService.pushLog(
      severityParam as any,
      message ?? 'Manual log entry',
    );

    return ApiResponseUtils.success(
      { pushed: true, severity: severityParam },
      'Log entry pushed',
    );
  }

  /**
   * POST /api/observability/logs/clear
   *
   * Clear all buffered log records.
   */
  @Post('logs/clear')
  @HttpCode(HttpStatus.OK)
  clearLogs() {
    this.observabilityService.clearLogs();
    return ApiResponseUtils.success({ cleared: true }, 'Log buffer cleared');
  }

  /**
   * GET /api/observability/health
   *
   * Lightweight health check specific to the observability subsystem.
   */
  @Get('health')
  getHealth() {
    return ApiResponseUtils.success({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      spanStats: this.spanStore.getStats(),
      logStats: this.logBuffer.getStats(),
    });
  }
}
