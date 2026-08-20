import { Injectable } from '@nestjs/common';

export interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: 'SPAN_KIND_SERVER' | 'SPAN_KIND_CLIENT' | 'SPAN_KIND_INTERNAL';
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: {
    code: 'STATUS_CODE_UNSET' | 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR';
    message: string;
  };
  attributes: Record<string, { stringValue: string }>;
  events: Array<{
    name: string;
    timeUnixNano: string;
    attributes: Record<string, { stringValue: string }>;
  }>;
}

export interface SpanStoreStats {
  activeSpanCount: number;
  completedSpanCount: number;
  maxCompletedSpans: number;
}

/**
 * In-memory store for active and recently completed request spans.
 * Provides OpenTelemetry-compatible span data for the observability endpoint.
 */
@Injectable()
export class SpanStoreService {
  private readonly activeSpans = new Map<string, OtelSpan>();
  private readonly completedSpans: OtelSpan[] = [];
  private readonly maxCompletedSpans: number;

  constructor() {
    this.maxCompletedSpans = 100;
  }

  /**
   * Register a new span (starts as active).
   */
  addSpan(span: OtelSpan): void {
    this.activeSpans.set(span.spanId, span);
  }

  /**
   * Move a span from active to completed.
   */
  finalizeSpan(
    spanId: string,
    endTimeUnixNano: string,
    statusCode: 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR',
  ): void {
    const span = this.activeSpans.get(spanId);
    if (!span) {
      return;
    }

    span.endTimeUnixNano = endTimeUnixNano;
    span.status = { code: statusCode, message: '' };
    this.activeSpans.delete(spanId);

    this.completedSpans.push(span);
    if (this.completedSpans.length > this.maxCompletedSpans) {
      this.completedSpans.shift();
    }
  }

  /**
   * Return all currently active spans.
   */
  getActiveSpans(): OtelSpan[] {
    return Array.from(this.activeSpans.values());
  }

  /**
   * Return recently completed spans (newest last).
   */
  getCompletedSpans(): readonly OtelSpan[] {
    return this.completedSpans;
  }

  /**
   * Return both active and completed spans.
   */
  getAllSpans(): { active: OtelSpan[]; completed: OtelSpan[] } {
    return {
      active: this.getActiveSpans(),
      completed: [...this.completedSpans],
    };
  }

  getStats(): SpanStoreStats {
    return {
      activeSpanCount: this.activeSpans.size,
      completedSpanCount: this.completedSpans.length,
      maxCompletedSpans: this.maxCompletedSpans,
    };
  }
}
