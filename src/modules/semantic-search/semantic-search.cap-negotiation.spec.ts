/**
 * Cap-negotiation integration coverage over REAL HTTP.
 *
 * `semantic-search.service.spec.ts` drives the service with a mocked axios,
 * which pins the call sequencing but never touches the wire. This file points
 * the real axios instance at a local stub sidecar (node `http` server) that
 * behaves like FastAPI does at the boundary — `/health` reports `maxK`,
 * `/search` answers 422 when `k` exceeds it — and replays the scenarios that
 * only exist when a sidecar restart changes `LAWCAST_SEMANTIC_MAX_K`
 * underneath a running backend: the clamp, the 422 -> forced re-read -> retry
 * recovery, and a dead `/health` degrading to the compiled default instead of
 * blocking the search.
 */
import { createServer } from 'http';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import express from 'express';
import { LoggerUtils } from '../../utils/logger.utils';
import { NoticeSearchService } from '../crawling/notice-search.service';
import { SemanticSearchService } from './semantic-search.service';
import { traceSemanticSearchRequest } from './semantic-search-timing';

const STAMP = '2026-10-02T12:00:00+00:00';
const QUERY = '임대차 계약에서 세입자 보호';
const TIMINGS = {
  denseMs: 2,
  annotateMs: 1,
  totalMs: 3,
  // Keep realistic clock precision when exercising the header byte budget.
  denseStages: {
    embedding: { startMs: 0.10000000000000002, durationMs: 0.9000000000000001 },
    embeddingStages: {
      tokenization: { startMs: 0.01, durationMs: 0.1 },
      model: { startMs: 0.11, durationMs: 0.6 },
      cpuConversion: { startMs: 0.71, durationMs: 0.1 },
    },
    faiss: { startMs: 1.1000000000000003, durationMs: 0.4000000000000001 },
    classification: {
      startMs: 1.5000000000000004,
      durationMs: 0.25000000000000006,
    },
  },
};

interface StubLogEntry {
  path: string;
  k: number | null;
  status: number;
}

interface StubSidecar {
  url: string;
  state: {
    maxK: number;
    healthDown: boolean;
    includeTimings: boolean;
    log: StubLogEntry[];
  };
  close: () => Promise<void>;
}

/** A window of `k` chunks over 50 distinct notices (chunk -> notice dedup). */
const noticeWindow = (k: number) =>
  Array.from({ length: k }, (_, i) => ({
    chunkId: `stub-${i}`,
    noticeNum: 1000 + (i % 50),
    subject: `법률안 ${1000 + (i % 50)}`,
    committee: '법제사법위원회',
    section: '제안이유',
    score: 0.5,
    text: `청크 ${i}`,
  }));

const startStubSidecar = async (): Promise<StubSidecar> => {
  const state = {
    maxK: 200,
    healthDown: false,
    includeTimings: false,
    log: [] as StubLogEntry[],
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const rawK = url.searchParams.get('k');
    const respond = (status: number, payload: unknown) => {
      state.log.push({
        path: url.pathname,
        k: rawK === null ? null : Number(rawK),
        status,
      });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === '/health') {
      if (state.healthDown) {
        respond(503, { detail: 'health unavailable' });
        return;
      }
      respond(200, {
        status: 'ready',
        model: 'stub-model',
        indexedChunks: 96646,
        lastUpdateAt: STAMP,
        lastUpdateTriggeredAt: null,
        updating: false,
        generation: 1,
        maxK: state.maxK,
      });
      return;
    }
    if (url.pathname === '/search') {
      const k = Number(rawK);
      if (!Number.isInteger(k) || k < 1 || k > state.maxK) {
        // FastAPI rejects out-of-range query params with 422 — the rejection
        // shape the backend's cap recovery keys on.
        respond(422, { detail: 'k is out of range' });
        return;
      }
      respond(200, {
        query: url.searchParams.get('query'),
        k,
        model: 'stub-model',
        lastUpdateAt: STAMP,
        results: noticeWindow(k),
        weakResults: [],
        ...(state.includeTimings && {
          timings: TIMINGS,
        }),
      });
      return;
    }
    respond(404, { detail: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Node >= 19 keeps connections alive; without this close() would
        // wait for the axios keep-alive socket to time out.
        server.closeAllConnections();
      }),
  };
};

describe('semantic sidecar cap negotiation (real HTTP)', () => {
  jest.setTimeout(15000);

  let stub: StubSidecar;

  beforeEach(async () => {
    stub = await startStubSidecar();
  });

  afterEach(async () => {
    await stub.close();
  });

  const createService = (): SemanticSearchService => {
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'semanticSearch.enabled') return true;
        if (key === 'semanticSearch.apiUrl') return stub.url;
        if (key === 'semanticSearch.timeout') return 5000;
        if (key === 'semanticSearch.chunkCapRefreshMs') return 60000;
        return undefined;
      }),
    } as unknown as ConfigService;
    const noticeSearchService = {
      searchNotices: jest.fn(async () => ({
        items: [],
        total: 0,
        page: 1,
        limit: 5,
        totalPages: 1,
        keyword: '',
        source: 'archive',
      })),
    } as unknown as NoticeSearchService;
    return new SemanticSearchService(configService, noticeSearchService);
  };

  /** The whole conversation in order: `path:status` per request. */
  const transcript = (): string[] =>
    stub.state.log.map((entry) => `${entry.path}:${entry.status}`);

  it('reads the cap first and clamps every window to it', async () => {
    stub.state.maxK = 30;
    const service = createService();

    const result = await service.searchSemantic(QUERY, 50);

    // k * 3 would ask for 150 chunks; the reported cap of 30 wins, and the
    // window sits at the cap, so there is exactly one round trip.
    expect(result.mode).toBe('semantic');
    expect(result.results).toHaveLength(30);
    expect(transcript()).toEqual(['/health:200', '/search:200']);
    expect(stub.state.log[1].k).toBe(30);
  });

  it('recovers when a restarted sidecar lowers the cap (422 -> re-read -> retry)', async () => {
    stub.state.maxK = 77;
    const service = createService();

    const first = await service.searchSemantic(QUERY, 50);
    expect(first.mode).toBe('semantic');
    expect(first.results).toHaveLength(50);

    // Sidecar restart with a lower LAWCAST_SEMANTIC_MAX_K: the backend's
    // cached cap (77) is now stale, so the next first window is rejected.
    stub.state.maxK = 30;
    const second = await service.searchSemantic(QUERY, 50);

    // The rejection was cap staleness, not a client error: forced /health
    // re-read, then one retry clamped to the new cap — never a keyword
    // fallback and never a surfaced 4xx.
    expect(second.mode).toBe('semantic');
    expect(second.results).toHaveLength(30);
    expect(transcript()).toEqual([
      '/health:200',
      '/search:200',
      '/search:422',
      '/health:200',
      '/search:200',
    ]);
    expect(stub.state.log[4].k).toBe(30);
  });

  it('keeps searching on the compiled default while /health is down', async () => {
    stub.state.healthDown = true;
    const service = createService();

    const result = await service.searchSemantic(QUERY, 50);

    // The health failure must not block the search: the compiled default
    // (100) applies, so the first window asks for 100 chunks.
    expect(result.mode).toBe('semantic');
    expect(result.results).toHaveLength(50);
    expect(transcript()).toEqual(['/health:503', '/search:200']);
    expect(stub.state.log[1].k).toBe(100);
  });

  it('returns correlated timing headers without altering the public response', async () => {
    const service = createService();
    await service.searchSemantic(QUERY, 50);
    stub.state.maxK = 30;
    stub.state.includeTimings = true;

    const traceId = '9143e6bf-bb78-48f3-bc53-e229fa542de5';
    const log = jest.spyOn(LoggerUtils, 'log').mockImplementation(() => {});
    const app = express();
    app.use(traceSemanticSearchRequest);
    app.get('/api/notices/semantic-search', async (req, res) => {
      if (req.query.limit === 'true') {
        res.status(429).json({ statusCode: 429 });
        return;
      }
      if (req.query.many === 'true') {
        for (let i = 0; i < 13; i++) await service.searchSemantic(QUERY, 1);
        res.json({ ok: true });
        return;
      }
      res.json(await service.searchSemantic(QUERY, 50));
    });
    const server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}/api/notices/semantic-search`;
      const response = await globalThis.fetch(url, {
        headers: { 'x-lawcast-search-trace': traceId },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty('timings');
      expect(response.headers.get('cache-control')).toBe('no-store');
      const header = JSON.parse(
        response.headers.get('x-lawcast-search-timing'),
      );
      expect(header).toMatchObject({
        traceId,
        backendMs: expect.any(Number),
        omittedCalls: 0,
      });
      expect(log).toHaveBeenCalledWith(
        'SemanticSearchTiming',
        expect.objectContaining({
          traceId,
          status: 200,
          backendMs: expect.any(Number),
          sidecarCalls: [
            expect.objectContaining({
              path: '/search',
              chunkK: 150,
              status: 422,
              outcome: 'error',
              startMs: expect.any(Number),
              roundTripMs: expect.any(Number),
            }),
            expect.objectContaining({ path: '/health', status: 200 }),
            expect.objectContaining({
              path: '/search',
              chunkK: 30,
              status: 200,
              outcome: 'ok',
              startMs: expect.any(Number),
              roundTripMs: expect.any(Number),
              timings: TIMINGS,
            }),
          ],
        }),
      );
      expect(header.sidecarCalls).toEqual(log.mock.calls[0][1].sidecarCalls);
      for (const [index, call] of header.sidecarCalls.entries()) {
        expect(call.startMs).toBeGreaterThanOrEqual(0);
        expect(call.startMs + call.roundTripMs).toBeLessThanOrEqual(
          header.backendMs + 0.02,
        );
        if (index > 0) {
          const previous = header.sidecarCalls[index - 1];
          expect(call.startMs + 0.02).toBeGreaterThanOrEqual(
            previous.startMs + previous.roundTripMs,
          );
        }
      }

      const many = await globalThis.fetch(`${url}?many=true`, {
        headers: { 'x-lawcast-search-trace': traceId },
      });
      expect(await many.json()).toEqual({ ok: true });
      const encoded = many.headers.get('x-lawcast-search-timing')!;
      const bounded = JSON.parse(encoded);
      expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(4096);
      expect(bounded.sidecarCalls.length).toBeLessThanOrEqual(12);
      expect(bounded.sidecarCalls.length + bounded.omittedCalls).toBe(13);
      expect(bounded.sidecarCalls[0].timings).toEqual(TIMINGS);

      stub.state.includeTimings = false;
      log.mockClear();
      const untraced = await globalThis.fetch(url);
      expect(untraced.headers.has('x-lawcast-search-timing')).toBe(false);
      await untraced.json();
      expect(log.mock.calls[0][1]).toMatchObject({
        sidecarCalls: [expect.objectContaining({ outcome: 'ok', status: 200 })],
      });
      expect(log.mock.calls[0][1].sidecarCalls[0]).not.toHaveProperty(
        'timings',
      );

      const limited = await globalThis.fetch(`${url}?limit=true`, {
        headers: { 'x-lawcast-search-trace': traceId },
      });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ statusCode: 429 });
      expect(
        JSON.parse(limited.headers.get('x-lawcast-search-timing')),
      ).toEqual({
        traceId,
        backendMs: expect.any(Number),
        sidecarCalls: [],
        omittedCalls: 0,
      });
    } finally {
      log.mockRestore();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });
});
