import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  Server,
  ServerCredentials,
  status,
  type ServiceDefinition,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import type { ConfigService } from '@nestjs/config';
import type { NoticeSearchService } from '../crawling/notice-search.service';
import { SemanticSearchService } from './semantic-search.service';
import {
  SEARCH_ATTEMPT_HEADER,
  TRACE_HEADER,
  traceSemanticSearchRequest,
} from './semantic-search-timing';

const definition = loadSync(join(__dirname, 'semantic_search.proto'))[
  'lawcast.semantic.v1.SemanticSearch'
] as ServiceDefinition;

describe('semantic search over a real gRPC channel', () => {
  let server: Server;
  let service: SemanticSearchService;
  let maxK: number;
  let requests: string[];
  let correlations: Array<{ trace: unknown; attempt: unknown }>;
  const traceId = 'abecd012-1234-4321-8765-abcdef987654';
  const tracedSearch = async (k: number) => {
    const app = express();
    app.use(traceSemanticSearchRequest);
    app.get('/api/notices/semantic-search', async (_req, res) =>
      res.json(await service.searchSemantic(query, k)),
    );
    const httpServer = app.listen(0, '127.0.0.1');
    try {
      if (!httpServer.listening)
        await new Promise<void>((resolve) =>
          httpServer.once('listening', resolve),
        );
      const { port } = httpServer.address() as AddressInfo;
      const response = await globalThis.fetch(
        `http://127.0.0.1:${port}/api/notices/semantic-search`,
        {
          headers: { [TRACE_HEADER]: traceId },
        },
      );
      return {
        status: response.status,
        body: await response.json(),
        trace: JSON.parse(response.headers.get('x-lawcast-search-timing')),
      };
    } finally {
      httpServer.close();
    }
  };
  let failure: 'invalid' | 'unavailable' | 'stall' | null;
  const query = '세입자 보호';

  beforeEach(async () => {
    maxK = 50;
    requests = [];
    correlations = [];
    failure = null;
    server = new Server();
    server.addService(definition, {
      GetHealth: ({ metadata }, reply) => {
        correlations.push({
          trace: metadata.get(TRACE_HEADER)[0],
          attempt: metadata.get(SEARCH_ATTEMPT_HEADER)[0],
        });
        requests.push('health');
        reply(null, { status: 'ready', indexedChunks: 1, maxK });
      },
      Search: ({ request, metadata }, reply) => {
        correlations.push({
          trace: metadata.get(TRACE_HEADER)[0],
          attempt: metadata.get(SEARCH_ATTEMPT_HEADER)[0],
        });
        requests.push(`search:${request.k}`);
        if (failure === 'stall') return;
        if (failure === 'invalid') {
          reply({ code: status.INVALID_ARGUMENT, message: 'invalid query' });
          return;
        }
        if (failure === 'unavailable') {
          reply({ code: status.UNAVAILABLE, message: 'engine not ready' });
          return;
        }
        if (request.k > maxK) {
          reply({ code: status.OUT_OF_RANGE, message: 'invalid chunk window' });
          return;
        }
        reply(null, {
          query: request.query,
          k: request.k,
          timings: {
            denseMs: 2,
            annotateMs: 1,
            totalMs: 3,
            admissionMs: 0.25,
            rankWaitMs: 0,
          },
          results: [
            {
              chunkId: '1-1',
              noticeNum: 1,
              subject: '임대차보호법',
              score: 0.5863,
              text: query,
              lexicalEvidence: false,
            },
          ],
        });
      },
    });
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync(
        '127.0.0.1:0',
        ServerCredentials.createInsecure(),
        (error, bound) => (error ? reject(error) : resolve(bound)),
      ),
    );
    const config = {
      'semanticSearch.grpcTarget': `127.0.0.1:${port}`,
      'semanticSearch.totalTimeoutMs': 500,
    };
    service = new SemanticSearchService(
      {
        get: (key: keyof typeof config) => config[key],
      } as ConfigService,
      {
        searchNotices: async () => ({ items: [] }),
      } as unknown as NoticeSearchService,
    );
  });

  afterEach(() => {
    service?.onModuleDestroy();
    server?.forceShutdown();
  });

  it('normalizes null stamps and empty tiers and refreshes a stale cap once', async () => {
    await expect(service.getEngineHealth()).resolves.toEqual({
      status: 'ready',
      indexedChunks: 1,
      lastUpdateAt: null,
      lastUpdateTriggeredAt: null,
    });
    maxK = 3;
    await expect(service.searchSemantic(query, 25)).resolves.toMatchObject({
      mode: 'semantic',
      lastUpdateAt: null,
      results: [{ noticeNum: 1, score: 0.5863 }],
      weakResults: [],
    });
    expect(requests).toEqual(['health', 'search:50', 'health', 'search:3']);
  });

  it('records raw RPC outcomes, retries and wait fields with matching metadata', async () => {
    await service.getEngineHealth();
    maxK = 3;
    const { status: httpStatus, trace, body } = await tracedSearch(25);
    expect(httpStatus).toBe(200);
    expect(body).not.toHaveProperty('timings');
    expect(trace.traceId).toBe(traceId);
    expect(trace.sidecarCalls).toMatchObject([
      { transport: 'grpc', grpcCode: status.OUT_OF_RANGE, outcome: 'error' },
      { transport: 'grpc', grpcCode: status.OK, path: '/health' },
      {
        transport: 'grpc',
        grpcCode: status.OK,
        timings: { admissionMs: 0.25, rankWaitMs: 0 },
      },
    ]);
    expect(trace.sidecarCalls.every((call) => !('status' in call))).toBe(true);
    expect(correlations.slice(1)).toEqual(
      ['1', '2', '3'].map((attempt) => ({ trace: traceId, attempt })),
    );
  });

  it('keeps the RPC deadline distinct from the successful HTTP fallback response', async () => {
    failure = 'stall';
    const { status: httpStatus, body, trace } = await tracedSearch(1);
    expect(httpStatus).toBe(200);
    expect(body.mode).toBe('keyword_fallback');
    expect(trace.sidecarCalls[1]).toMatchObject({
      transport: 'grpc',
      grpcCode: status.DEADLINE_EXCEEDED,
      outcome: 'error',
    });
    expect(trace.sidecarCalls[1]).not.toHaveProperty('status');
  });

  it('returns bad request without retrying an invalid query', async () => {
    failure = 'invalid';
    await expect(service.searchSemantic(query, 1)).rejects.toMatchObject({
      status: 400,
    });
    expect(requests).toEqual(['health', 'search:3']);
  });

  it.each(['unavailable', 'stall'] as const)(
    'degrades to keyword search when the first RPC is %s',
    async (condition) => {
      failure = condition;
      await expect(service.searchSemantic(query, 1)).resolves.toMatchObject({
        mode: 'keyword_fallback',
      });
      expect(requests).toEqual(['health', 'search:3']);
    },
  );
});
