import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { SpanStoreService } from './span-store.service';

/**
 * Generates a compact 16-byte hex trace ID (random, for local tracing).
 */
function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  // Use crypto.getRandomValues if available, else Math.random fallback
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generates a compact 8-byte hex span ID.
 */
function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 8; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

@Injectable()
export class RequestSpanInterceptor implements NestInterceptor {
  constructor(private readonly spanStore: SpanStoreService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    const startTime = process.hrtime.bigint();
    const method = request?.method ?? 'UNKNOWN';
    const url = request?.originalUrl ?? request?.url ?? '/';
    const route = request?.route?.path ?? url;

    const span = {
      traceId,
      spanId,
      parentSpanId: null as string | null,
      name: `${method} ${route}`,
      kind: 'SPAN_KIND_SERVER' as const,
      startTimeUnixNano: startTime.toString(),
      endTimeUnixNano: '',
      status: {
        code: 'STATUS_CODE_UNSET' as
          'STATUS_CODE_UNSET' | 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR',
        message: '',
      } as {
        code: 'STATUS_CODE_UNSET' | 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR';
        message: string;
      },
      attributes: {
        'http.method': { stringValue: method },
        'http.url': { stringValue: url },
        'http.route': { stringValue: route },
        'http.scheme': { stringValue: request?.protocol ?? 'http' },
        'http.host': { stringValue: request?.get('host') ?? 'localhost' },
        'http.user_agent': {
          stringValue: request?.get('user-agent') ?? '',
        },
        'http.remote_addr': {
          stringValue:
            (request?.headers?.['x-forwarded-for'] as string) ??
            request?.ip ??
            '',
        },
      },
      events: [] as any[],
    };

    this.spanStore.addSpan(span);

    return next.handle().pipe(
      tap({
        next: () => {
          const endTime = process.hrtime.bigint();
          const durationMs = Number(endTime - startTime) / 1e6;
          span.endTimeUnixNano = endTime.toString();
          span.status = { code: 'STATUS_CODE_OK', message: '' };
          span.attributes['http.status_code'] = {
            stringValue: String(
              context.switchToHttp().getResponse()?.statusCode ?? 200,
            ),
          };
          span.attributes['duration_ms'] = {
            stringValue: durationMs.toFixed(2),
          };
          this.spanStore.finalizeSpan(
            spanId,
            endTime.toString(),
            'STATUS_CODE_OK',
          );
        },
        error: (err: any) => {
          const endTime = process.hrtime.bigint();
          const durationMs = Number(endTime - startTime) / 1e6;
          span.endTimeUnixNano = endTime.toString();
          span.status = {
            code: 'STATUS_CODE_ERROR',
            message: err?.message ?? 'Unknown error',
          };
          const statusCode = err?.status ?? err?.statusCode ?? 500;
          span.attributes['http.status_code'] = {
            stringValue: String(statusCode),
          };
          span.attributes['duration_ms'] = {
            stringValue: durationMs.toFixed(2),
          };
          span.events.push({
            name: 'exception',
            timeUnixNano: endTime.toString(),
            attributes: {
              'exception.type': {
                stringValue: err?.name ?? 'Error',
              },
              'exception.message': {
                stringValue: err?.message ?? 'Unknown error',
              },
            },
          });
          this.spanStore.finalizeSpan(
            spanId,
            endTime.toString(),
            'STATUS_CODE_ERROR',
          );
        },
      }),
    );
  }
}
