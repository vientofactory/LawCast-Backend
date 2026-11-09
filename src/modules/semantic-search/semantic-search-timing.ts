import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import axios, { type AxiosResponse } from 'axios';
import type { RequestHandler } from 'express';
import { LoggerUtils } from '../../utils/logger.utils';
import type {
  SemanticDenseStages,
  SemanticDensePhase,
  SemanticSidecarTimings,
} from './semantic-search.types';

interface SidecarCall {
  path: '/health' | '/search';
  chunkK?: number;
  startMs: number;
  roundTripMs?: number;
  status?: number;
  outcome: 'pending' | 'ok' | 'error';
  timings?: SemanticSidecarTimings;
}

const TRACE_HEADER = 'x-lawcast-search-trace';
const TIMING_HEADER = 'x-lawcast-search-timing';
const MAX_HEADER_CALLS = 12;
const MAX_HEADER_BYTES = 4096;
const EMBEDDING_STAGE_KEYS = [
  'tokenization',
  'model',
  'cpuConversion',
] as const;
const DENSE_STAGE_KEYS = ['embedding', 'faiss', 'classification'] as const;
const TRACE_ID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const searchTrace = new AsyncLocalStorage<{
  started: number;
  sidecarCalls: SidecarCall[];
}>();

function elapsedMs(start: number) {
  return Number((performance.now() - start).toFixed(2));
}

const isDuration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function readStages<Key extends string>(
  value: Record<Key, SemanticDensePhase> | null | undefined,
  keys: readonly Key[],
  parentMs: number,
) {
  if (!value) return undefined;
  const stages = {} as Record<Key, SemanticDensePhase>;
  let previousEnd = 0;
  for (const key of keys) {
    const phase = value[key];
    if (!isDuration(phase?.startMs) || !isDuration(phase?.durationMs))
      return undefined;
    const { startMs, durationMs } = phase;
    const end = startMs + durationMs;
    if (startMs + 1e-6 < previousEnd || end > parentMs + 1e-6) return undefined;
    stages[key] = { startMs, durationMs };
    previousEnd = end;
  }
  return stages;
}

function readDenseStages(
  value: SemanticDenseStages | null | undefined,
  denseMs: number,
): SemanticDenseStages | undefined {
  const stages = readStages(value, DENSE_STAGE_KEYS, denseMs);
  if (!stages) return undefined;
  const embeddingStages = readStages(
    value?.embeddingStages,
    EMBEDDING_STAGE_KEYS,
    stages.embedding.durationMs,
  );
  return embeddingStages ? { ...stages, embeddingStages } : stages;
}

function encodeTimingHeader(
  traceId: string,
  backendMs: number,
  calls: SidecarCall[],
) {
  for (let count = Math.min(calls.length, MAX_HEADER_CALLS); ; count--) {
    const encoded = JSON.stringify({
      traceId,
      backendMs,
      sidecarCalls: calls.slice(0, count),
      omittedCalls: calls.length - count,
    });
    if (count === 0 || Buffer.byteLength(encoded) <= MAX_HEADER_BYTES)
      return encoded;
  }
}

export const traceSemanticSearchRequest: RequestHandler = (req, res, next) => {
  const path = req.path.toLowerCase().replace(/\/$/, '');
  const isBoardSearch =
    path === '/api/notices/archive' &&
    (req.query.searchMode === 'auto' || req.query.searchMode === 'semantic') &&
    typeof req.query.search === 'string' &&
    !!req.query.search.trim() &&
    !req.query.noticeNums;
  if (
    req.method !== 'GET' ||
    (path !== '/api/notices/semantic-search' && !isBoardSearch)
  ) {
    return next();
  }

  const suppliedId = req.get(TRACE_HEADER);
  const wantsTiming = suppliedId !== undefined && TRACE_ID.test(suppliedId);
  const traceId = wantsTiming ? suppliedId : randomUUID();
  const started = performance.now();
  const sidecarCalls: SidecarCall[] = [];
  if (wantsTiming) {
    const writeHead = res.writeHead;
    // Finalize at header commit so errors and fallback responses can carry
    // timings without changing the API body. The close log also counts flush time.
    res.writeHead = function (statusCode: number, ...args: unknown[]) {
      if (!this.headersSent) {
        this.setHeader('Cache-Control', 'no-store');
        this.setHeader(
          TIMING_HEADER,
          encodeTimingHeader(traceId, elapsedMs(started), sidecarCalls),
        );
      }
      return Reflect.apply(writeHead, this, [statusCode, ...args]);
    };
  }
  res.once('close', () => {
    LoggerUtils.log('SemanticSearchTiming', {
      traceId,
      path,
      backendMs: elapsedMs(started),
      status: res.writableFinished ? res.statusCode : undefined,
      aborted: !res.writableFinished,
      sidecarCalls,
    });
  });
  searchTrace.run({ started, sidecarCalls }, next);
};

export function measureSemanticSidecarCall<T>(
  path: SidecarCall['path'],
  send: () => Promise<AxiosResponse<T>>,
  chunkK?: number,
): Promise<AxiosResponse<T>> {
  const trace = searchTrace.getStore();
  if (!trace) return send();

  const started = performance.now();
  const call: SidecarCall = {
    path,
    chunkK,
    startMs: Number((started - trace.started).toFixed(2)),
    outcome: 'pending',
  };
  trace.sidecarCalls.push(call);
  return send()
    .then((response) => {
      call.status = response.status;
      call.outcome = 'ok';
      if (path === '/search') {
        const { denseMs, annotateMs, totalMs, denseStages } =
          (response.data as { timings?: SemanticSidecarTimings })?.timings ??
          {};
        if (
          isDuration(denseMs) &&
          isDuration(annotateMs) &&
          isDuration(totalMs)
        ) {
          const stages = readDenseStages(denseStages, denseMs);
          call.timings = {
            denseMs,
            annotateMs,
            totalMs,
            ...(stages && { denseStages: stages }),
          };
        }
      }
      return response;
    })
    .catch((error: unknown) => {
      call.outcome = 'error';
      if (axios.isAxiosError(error)) call.status = error.response?.status;
      throw error;
    })
    .finally(() => {
      call.roundTripMs = elapsedMs(started);
    });
}
