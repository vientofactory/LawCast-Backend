import { Module, Global } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ObservabilityService } from './observability.service';
import { ObservabilityController } from './observability.controller';
import { SpanStoreService } from './span-store.service';
import { LogBufferService } from './log-buffer.service';
import { RequestSpanInterceptor } from './request-span.interceptor';

/**
 * Observability module that exposes OpenTelemetry-compatible debugging data
 * through REST endpoints.
 *
 * Provides:
 *   - Span tracking via RequestSpanInterceptor (registered globally)
 *   - Structured log buffering
 *   - Process runtime metrics collection
 *
 * Endpoints:
 *   GET  /api/observability          — full payload (metrics + traces + logs)
 *   GET  /api/observability/metrics  — metrics only
 *   GET  /api/observability/traces   — traces/spans only
 *   GET  /api/observability/logs     — logs only
 *   POST /api/observability/logs     — push a custom log entry
 *   POST /api/observability/logs/clear — clear log buffer
 *   GET  /api/observability/health   — observability subsystem health
 */
@Global()
@Module({
  controllers: [ObservabilityController],
  providers: [
    SpanStoreService,
    LogBufferService,
    ObservabilityService,
    RequestSpanInterceptor,
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestSpanInterceptor,
    },
  ],
  exports: [
    ObservabilityService,
    SpanStoreService,
    LogBufferService,
    RequestSpanInterceptor,
  ],
})
export class ObservabilityModule {}
