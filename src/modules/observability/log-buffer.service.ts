import { Injectable, OnModuleInit } from '@nestjs/common';

/**
 * OpenTelemetry-compatible severity number mapping.
 * @see https://opentelemetry.io/docs/specs/otlp/#logdata-severitynumber
 */
export enum OtelSeverityNumber {
  UNSPECIFIED = 0,
  TRACE = 1,
  TRACE2 = 2,
  TRACE3 = 3,
  TRACE4 = 4,
  DEBUG = 5,
  DEBUG2 = 6,
  DEBUG3 = 7,
  DEBUG4 = 8,
  INFO = 9,
  INFO2 = 10,
  INFO3 = 11,
  INFO4 = 12,
  WARN = 13,
  WARN2 = 14,
  WARN3 = 15,
  WARN4 = 16,
  ERROR = 17,
  ERROR2 = 18,
  ERROR3 = 19,
  ERROR4 = 20,
  FATAL = 21,
  FATAL2 = 22,
  FATAL3 = 23,
  FATAL4 = 24,
}

export const SEVERITY_NUMBER_TO_NAME: Record<OtelSeverityNumber, string> = {
  [OtelSeverityNumber.UNSPECIFIED]: 'SEVERITY_NUMBER_UNSPECIFIED',
  [OtelSeverityNumber.TRACE]: 'SEVERITY_NUMBER_TRACE',
  [OtelSeverityNumber.TRACE2]: 'SEVERITY_NUMBER_TRACE2',
  [OtelSeverityNumber.TRACE3]: 'SEVERITY_NUMBER_TRACE3',
  [OtelSeverityNumber.TRACE4]: 'SEVERITY_NUMBER_TRACE4',
  [OtelSeverityNumber.DEBUG]: 'SEVERITY_NUMBER_DEBUG',
  [OtelSeverityNumber.DEBUG2]: 'SEVERITY_NUMBER_DEBUG2',
  [OtelSeverityNumber.DEBUG3]: 'SEVERITY_NUMBER_DEBUG3',
  [OtelSeverityNumber.DEBUG4]: 'SEVERITY_NUMBER_DEBUG4',
  [OtelSeverityNumber.INFO]: 'SEVERITY_NUMBER_INFO',
  [OtelSeverityNumber.INFO2]: 'SEVERITY_NUMBER_INFO2',
  [OtelSeverityNumber.INFO3]: 'SEVERITY_NUMBER_INFO3',
  [OtelSeverityNumber.INFO4]: 'SEVERITY_NUMBER_INFO4',
  [OtelSeverityNumber.WARN]: 'SEVERITY_NUMBER_WARN',
  [OtelSeverityNumber.WARN2]: 'SEVERITY_NUMBER_WARN2',
  [OtelSeverityNumber.WARN3]: 'SEVERITY_NUMBER_WARN3',
  [OtelSeverityNumber.WARN4]: 'SEVERITY_NUMBER_WARN4',
  [OtelSeverityNumber.ERROR]: 'SEVERITY_NUMBER_ERROR',
  [OtelSeverityNumber.ERROR2]: 'SEVERITY_NUMBER_ERROR2',
  [OtelSeverityNumber.ERROR3]: 'SEVERITY_NUMBER_ERROR3',
  [OtelSeverityNumber.ERROR4]: 'SEVERITY_NUMBER_ERROR4',
  [OtelSeverityNumber.FATAL]: 'SEVERITY_NUMBER_FATAL',
  [OtelSeverityNumber.FATAL2]: 'SEVERITY_NUMBER_FATAL2',
  [OtelSeverityNumber.FATAL3]: 'SEVERITY_NUMBER_FATAL3',
  [OtelSeverityNumber.FATAL4]: 'SEVERITY_NUMBER_FATAL4',
};

/**
 * Converts a human-readable severity name to its OTLP severity number.
 */
export function toOtelSeverityNumber(name: string): OtelSeverityNumber {
  const map: Record<string, OtelSeverityNumber> = {
    TRACE: OtelSeverityNumber.TRACE,
    DEBUG: OtelSeverityNumber.DEBUG,
    LOG: OtelSeverityNumber.INFO,
    INFO: OtelSeverityNumber.INFO,
    WARN: OtelSeverityNumber.WARN,
    WARNING: OtelSeverityNumber.WARN,
    ERROR: OtelSeverityNumber.ERROR,
    FATAL: OtelSeverityNumber.FATAL,
  };
  return map[name?.toUpperCase()] ?? OtelSeverityNumber.UNSPECIFIED;
}

export interface LogRecord {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityNumber: OtelSeverityNumber;
  severityText: string;
  body: { stringValue: string };
  attributes: Record<string, { stringValue: string }>;
}

export interface LogBufferStats {
  maxSize: number;
  currentSize: number;
  droppedCount: number;
  oldestEntryAt: string | null;
}

/**
 * In-memory circular buffer that stores recent structured log records
 * in OTLP-compatible LogData format.
 *
 * This does NOT replace the NestJS logger — it captures a window of
 * recent log output for diagnostic dump via the observability endpoint.
 */
@Injectable()
export class LogBufferService implements OnModuleInit {
  private readonly buffer: LogRecord[] = [];
  private readonly maxSize: number;
  private droppedCount = 0;

  constructor() {
    this.maxSize = 200;
  }

  onModuleInit() {
    this.push(OtelSeverityNumber.INFO, 'LogBufferService initialized', {
      service: 'log-buffer',
    });
  }

  /**
   * Append a log record to the circular buffer.
   */
  push(
    severityNumber: OtelSeverityNumber,
    message: string,
    attributes: Record<string, string> = {},
  ): void {
    const now = process.hrtime.bigint().toString();
    const record: LogRecord = {
      timeUnixNano: now,
      observedTimeUnixNano: now,
      severityNumber,
      severityText: SEVERITY_NUMBER_TO_NAME[severityNumber] ?? 'UNSPECIFIED',
      body: { stringValue: message },
      attributes: Object.fromEntries(
        Object.entries(attributes).map(([k, v]) => [k, { stringValue: v }]),
      ),
    };

    if (this.buffer.length >= this.maxSize) {
      this.buffer.shift();
      this.droppedCount++;
    }

    this.buffer.push(record);
  }

  /**
   * Return all buffered log records (newest last).
   */
  getRecords(): readonly LogRecord[] {
    return this.buffer;
  }

  /**
   * Return log records filtered by minimum severity.
   */
  getRecordsBySeverity(minSeverity: OtelSeverityNumber): LogRecord[] {
    return this.buffer.filter((r) => r.severityNumber >= minSeverity);
  }

  getStats(): LogBufferStats {
    return {
      maxSize: this.maxSize,
      currentSize: this.buffer.length,
      droppedCount: this.droppedCount,
      oldestEntryAt:
        this.buffer.length > 0 ? this.buffer[0].timeUnixNano : null,
    };
  }

  clear(): void {
    this.buffer.length = 0;
    this.droppedCount = 0;
  }
}
