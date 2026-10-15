import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import axios, { AxiosError } from 'axios';
import { NoticeSearchService } from '../crawling/notice-search.service';
import { SemanticSearchService } from './semantic-search.service';

jest.mock('axios');

describe('SemanticSearchService', () => {
  const STAMP = '2026-10-02T12:00:00+00:00';
  const TRIGGERED_AT = '2026-10-02T13:00:00+00:00';
  const mockGet =
    jest.fn<(url: string, config?: unknown) => Promise<{ data: unknown }>>();
  const mockSearchNotices =
    jest.fn<(query: unknown) => Promise<Record<string, unknown>>>();
  const mockedAxios = axios as jest.Mocked<typeof axios>;

  const createService = (
    enabled = true,
    chunkCapRefreshMs = 60_000,
    lexicalGate: 'off' | 'shadow' | 'enforce' = 'off',
    lexicalBypassScore = 0.6,
    rerankCutoff: number | null = null,
  ): SemanticSearchService => {
    mockedAxios.create.mockReturnValue({ get: mockGet } as any);

    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'semanticSearch.enabled') return enabled;
        if (key === 'semanticSearch.apiUrl') return 'http://127.0.0.1:8300';
        if (key === 'semanticSearch.timeout') return 10000;
        if (key === 'semanticSearch.chunkCapRefreshMs')
          return chunkCapRefreshMs;
        if (key === 'semanticSearch.lexicalGate') return lexicalGate;
        if (key === 'semanticSearch.lexicalBypassScore')
          return lexicalBypassScore;
        if (key === 'semanticSearch.rerankCutoff') return rerankCutoff;
        return undefined;
      }),
    } as unknown as ConfigService;

    const noticeSearchService = {
      searchNotices: mockSearchNotices,
    } as unknown as NoticeSearchService;

    return new SemanticSearchService(configService, noticeSearchService);
  };

  const sidecarChunk = (noticeNum: number, text: string) => ({
    chunkId: `${noticeNum}-0000`,
    noticeNum,
    subject: `법률안 ${noticeNum}`,
    committee: '법제사법위원회',
    section: '제안이유',
    score: 0.5,
    text,
  });

  /** Calls the service made to the sidecar's `/search` endpoint. */
  const searchCalls = () =>
    mockGet.mock.calls.filter((call) => call[0] === '/search');

  /** Calls the service made to the sidecar's `/health` endpoint. */
  const healthCalls = () =>
    mockGet.mock.calls.filter((call) => call[0] === '/health');

  const requestedChunkK = (): number[] =>
    searchCalls().map(
      (call) => (call[1] as { params: { k: number } }).params.k,
    );

  /**
   * `/health` payload for cap-reading tests; omit `maxK` to model a sidecar
   * older than the field (it then has the compiled default hardcoded).
   */
  const healthPayload = (maxK?: number) => ({
    data: {
      status: 'ready',
      model: 'nlpai-lab/KURE-v1',
      indexedChunks: 93031,
      lastUpdateAt: STAMP,
      lastUpdateTriggeredAt: TRIGGERED_AT,
      ...(maxK === undefined ? {} : { maxK }),
    },
  });

  const chunkWindow = (spec: Array<[number, number]>) =>
    spec.flatMap(([noticeNum, count]) =>
      Array.from({ length: count }, (_, i) =>
        sidecarChunk(noticeNum, `청크 ${noticeNum}-${i}`),
      ),
    );

  /** A full-size window holding `notices` distinct notices: the first
   * notice carries the bulk of the chunks, the rest one each. */
  const fullWindow = (size: number, notices: number) => ({
    data: {
      query: '질의',
      k: size,
      model: 'nlpai-lab/KURE-v1',
      results: chunkWindow([
        [101, size - notices + 1],
        ...Array.from(
          { length: notices - 1 },
          (_, i) => [102 + i, 1] as [number, number],
        ),
      ]),
    },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.isAxiosError.mockImplementation(
      (payload: any): payload is AxiosError<any, any, any> =>
        Boolean(payload?.isAxiosError),
    );
  });

  it('returns notice-deduplicated semantic hits', async () => {
    const service = createService();
    mockGet.mockResolvedValue({
      data: {
        query: '세입자 보호',
        k: 5,
        model: 'nlpai-lab/KURE-v1',
        lastUpdateAt: STAMP,
        results: [
          sidecarChunk(101, '첫 번째 청크'),
          sidecarChunk(101, '중복 청크'),
          sidecarChunk(102, '다른 공고'),
        ],
      },
    });

    const result = await service.searchSemantic('세입자 보호', 5);

    expect(result.mode).toBe('semantic');
    expect(result.fallbackReason).toBeNull();
    expect(result.lastUpdateAt).toBe(STAMP);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      noticeNum: 101,
      subject: '법률안 101',
      committee: '법제사법위원회',
      section: '제안이유',
      score: 0.5,
      excerpt: '첫 번째 청크',
    });
    // One oversized chunk window (k * 3) per request; a short sidecar
    // answer means the corpus is exhausted, so no widening is attempted.
    expect(mockGet).toHaveBeenCalledWith('/search', {
      params: { query: '세입자 보호', k: 15 },
    });
    expect(searchCalls()).toHaveLength(1);
  });

  it('keeps weak hits out of results and passes them alongside', async () => {
    const service = createService();
    mockGet.mockResolvedValue({
      data: {
        query: '세입자 보호',
        k: 15,
        model: 'nlpai-lab/KURE-v1',
        lastUpdateAt: STAMP,
        results: [sidecarChunk(101, '명확한 청크')],
        weakResults: [sidecarChunk(102, '관련도가 낮은 청크')],
      },
    });

    const result = await service.searchSemantic('세입자 보호', 5);

    // The tiers stay disjoint: weak hits never leak into `results`.
    expect(result.results.map((hit) => hit.noticeNum)).toEqual([101]);
    expect(result.weakResults.map((hit) => hit.noticeNum)).toEqual([102]);
    expect(mockSearchNotices).not.toHaveBeenCalled();
  });

  it('keeps weak hits when the clear tier is empty (no keyword fallback)', async () => {
    const service = createService();
    mockGet.mockResolvedValue({
      data: {
        query: '질의',
        k: 15,
        model: 'nlpai-lab/KURE-v1',
        lastUpdateAt: STAMP,
        results: [],
        weakResults: [
          sidecarChunk(102, '약한 청크 1'),
          sidecarChunk(102, '약한 청크 2'),
          sidecarChunk(103, '약한 청크 3'),
        ],
      },
    });

    const result = await service.searchSemantic('질의', 5);

    // An empty clear tier is the engine's real answer (unrelated hits were
    // already dropped by the sidecar); the weak band still rides along for
    // the UI's explicit reveal, and keyword search never substitutes in.
    expect(result.mode).toBe('semantic');
    expect(result.fallbackReason).toBeNull();
    expect(result.results).toEqual([]);
    expect(result.weakResults.map((hit) => hit.noticeNum)).toEqual([102, 103]);
    expect(result.lastUpdateAt).toBe(STAMP);
    expect(mockSearchNotices).not.toHaveBeenCalled();
  });

  it('widens the chunk window until k notice hits are filled', async () => {
    const service = createService();
    mockGet
      .mockResolvedValueOnce(healthPayload(200))
      .mockResolvedValueOnce({
        data: {
          query: '세입자 보호',
          k: 15,
          model: 'nlpai-lab/KURE-v1',
          results: chunkWindow([
            [101, 13],
            [102, 2],
          ]),
        },
      })
      .mockResolvedValueOnce({
        data: {
          query: '세입자 보호',
          k: 30,
          model: 'nlpai-lab/KURE-v1',
          results: chunkWindow([
            [101, 13],
            [102, 2],
            [103, 5],
            [104, 5],
            [105, 5],
          ]),
        },
      });

    const result = await service.searchSemantic('세입자 보호', 5);

    // k is a result count: 5 notices are filled even though the first
    // chunk window collapsed to only 2.
    expect(result.results.map((hit) => hit.noticeNum)).toEqual([
      101, 102, 103, 104, 105,
    ]);
    expect(requestedChunkK()).toEqual([15, 30]);
  });

  it('stops widening at the sidecar chunk cap and trims to k', async () => {
    const service = createService();
    mockGet
      .mockResolvedValueOnce(healthPayload(200))
      .mockResolvedValueOnce(fullWindow(150, 40))
      .mockResolvedValueOnce(fullWindow(200, 80));

    const result = await service.searchSemantic('질의', 50);

    expect(result.results).toHaveLength(50);
    // 50 * 3 = 150, then one widening pass clamped to the sidecar cap.
    expect(requestedChunkK()).toEqual([150, 200]);
  });

  it('returns fewer than k only when the capped chunk window holds fewer notices', async () => {
    const service = createService();
    const singleNoticeWindow = (size: number) => ({
      data: {
        query: '질의',
        k: size,
        model: 'nlpai-lab/KURE-v1',
        results: chunkWindow([[101, size]]),
      },
    });
    mockGet
      .mockResolvedValueOnce(healthPayload(200))
      .mockResolvedValueOnce(singleNoticeWindow(150))
      .mockResolvedValueOnce(singleNoticeWindow(200));

    const result = await service.searchSemantic('질의', 50);

    expect(result.results).toHaveLength(1);
    expect(requestedChunkK()).toEqual([150, 200]);
    expect(searchCalls()).toHaveLength(2);
  });

  // Cap negotiation: the sidecar owns the chunk-window cap
  // (LAWCAST_SEMANTIC_MAX_K) and reports it at `/health`; the backend must
  // follow it instead of the compiled SIDE_CAR_MAX_CHUNK_K, and must degrade
  // to that constant whenever the report is unavailable or too old.
  it('clamps every chunk window to the cap the sidecar reports', async () => {
    const service = createService();
    mockGet
      .mockResolvedValueOnce(healthPayload(30))
      .mockResolvedValueOnce(fullWindow(30, 2));

    const result = await service.searchSemantic('질의', 50);

    // k * 3 would ask for 150 chunks; the reported cap of 30 wins, and the
    // window already sits at the cap, so no widening pass follows.
    expect(requestedChunkK()).toEqual([30]);
    expect(result.mode).toBe('semantic');
    expect(result.results).toHaveLength(2);
    expect(mockSearchNotices).not.toHaveBeenCalled();
  });

  it('falls back to the compiled cap when /health is unreachable', async () => {
    const service = createService();
    mockGet
      .mockRejectedValueOnce({
        isAxiosError: true,
        code: 'ECONNREFUSED',
        message: 'connect ECONNREFUSED 127.0.0.1:8300',
      })
      .mockResolvedValueOnce(fullWindow(150, 40))
      .mockResolvedValueOnce(fullWindow(200, 80));

    const result = await service.searchSemantic('질의', 50);

    // The health failure degrades to SIDE_CAR_MAX_CHUNK_K: widening still
    // clamps at 200 and the search keeps serving.
    expect(result.mode).toBe('semantic');
    expect(result.results).toHaveLength(50);
    expect(requestedChunkK()).toEqual([150, 200]);
    expect(healthCalls()).toHaveLength(1);
  });

  it('falls back to the compiled cap when an older sidecar omits maxK', async () => {
    const service = createService();
    mockGet
      .mockResolvedValueOnce(healthPayload()) // no maxK field
      .mockResolvedValueOnce(fullWindow(150, 40))
      .mockResolvedValueOnce(fullWindow(200, 80));

    await service.searchSemantic('질의', 50);

    // A sidecar predating the field has 200 hardcoded, which is exactly the
    // compiled default the backend falls back to.
    expect(requestedChunkK()).toEqual([150, 200]);
  });

  it('reads the cap once per freshness window instead of once per search', async () => {
    const service = createService();
    mockGet
      .mockResolvedValueOnce(healthPayload(50))
      .mockResolvedValue(fullWindow(15, 5));

    await service.searchSemantic('질의', 5);
    await service.searchSemantic('질의', 5);

    expect(healthCalls()).toHaveLength(1);
    expect(searchCalls()).toHaveLength(2);
    // The reported cap applies to both searches (15 < 50 stays untouched).
    expect(requestedChunkK()).toEqual([15, 15]);
  });

  it('re-reads the cap after the freshness window so a restart lands', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-02T00:00:00Z'));
    try {
      const service = createService();
      mockGet
        .mockResolvedValueOnce(healthPayload(50))
        .mockResolvedValueOnce(fullWindow(15, 5))
        .mockResolvedValueOnce(healthPayload(80))
        .mockResolvedValueOnce(fullWindow(15, 5));

      await service.searchSemantic('질의', 5);
      jest.setSystemTime(new Date('2026-10-02T00:01:01Z')); // beyond the TTL
      await service.searchSemantic('질의', 5);

      expect(healthCalls()).toHaveLength(2);
      expect(searchCalls()).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('honors an injected cap freshness window longer than the default', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-02T00:00:00Z'));
    try {
      // SEMANTIC_SEARCH_CHUNK_CAP_REFRESH_MS = 5 minutes: the search 61s
      // later must reuse the cached cap instead of re-reading /health.
      const service = createService(true, 5 * 60 * 1000);
      mockGet
        .mockResolvedValueOnce(healthPayload(50))
        .mockResolvedValueOnce(fullWindow(15, 5))
        .mockResolvedValueOnce(fullWindow(15, 5));

      await service.searchSemantic('질의', 5);
      jest.setSystemTime(new Date('2026-10-02T00:01:01Z'));
      await service.searchSemantic('질의', 5);

      expect(healthCalls()).toHaveLength(1);
      expect(searchCalls()).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('re-reads the cap every search when the injected window is zero', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-02T00:00:00Z'));
    try {
      const service = createService(true, 0);
      mockGet
        .mockResolvedValueOnce(healthPayload(50))
        .mockResolvedValueOnce(fullWindow(15, 5))
        .mockResolvedValueOnce(healthPayload(50))
        .mockResolvedValueOnce(fullWindow(15, 5));

      await service.searchSemantic('질의', 5);
      await service.searchSemantic('질의', 5);

      // A zero window disables caching (immediate propagation).
      expect(healthCalls()).toHaveLength(2);
      expect(searchCalls()).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('refreshes the cap and retries when a stale cap gets the first window rejected', async () => {
    const service = createService();
    mockGet
      .mockResolvedValueOnce(healthPayload(200)) // cached cap (pre-restart)
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 422 },
        message: 'Request failed with status code 422',
      }) // first window asked for 150 chunks, cap is now 50
      .mockResolvedValueOnce(healthPayload(50)) // forced re-read
      .mockResolvedValueOnce({
        data: {
          query: '질의',
          k: 50,
          model: 'nlpai-lab/KURE-v1',
          results: chunkWindow([[101, 50]]),
        },
      });

    const result = await service.searchSemantic('질의', 50);

    // The rejection was cap staleness, not a client error: one re-read, one
    // retry clamped to the reported cap, no keyword fallback involved.
    expect(result.mode).toBe('semantic');
    expect(requestedChunkK()).toEqual([150, 50]);
    expect(healthCalls()).toHaveLength(2);
    expect(mockSearchNotices).not.toHaveBeenCalled();
  });

  it('surfaces a 422 a refreshed cap cannot explain without a second window', async () => {
    const service = createService();
    mockGet
      .mockResolvedValueOnce(healthPayload(200))
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 422 },
        message: 'Request failed with status code 422',
      })
      .mockResolvedValueOnce(healthPayload(200)); // re-read says nothing changed

    await expect(service.searchSemantic('질의', 50)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(searchCalls()).toHaveLength(1);
    expect(healthCalls()).toHaveLength(2);
    expect(mockSearchNotices).not.toHaveBeenCalled();
  });

  // Failure-policy matrix: a failed WIDENING request never discards the
  // chunks already collected (partial semantic results, count < k allowed),
  // whatever the rejection shape. Only a failed FIRST window degrades to the
  // keyword fallback.
  it.each<[string, Record<string, unknown>]>([
    [
      'sidecar outage',
      {
        isAxiosError: true,
        response: { status: 503 },
        message: 'Request failed with status code 503',
      },
    ],
    [
      'network error',
      {
        isAxiosError: true,
        code: 'ECONNREFUSED',
        message: 'connect ECONNREFUSED 127.0.0.1:8300',
      },
    ],
    [
      'client-contract violation',
      {
        isAxiosError: true,
        response: { status: 422 },
        message: 'Request failed with status code 422',
      },
    ],
  ])(
    'keeps partial semantic results when a widening request fails (%s)',
    async (_label, rejection) => {
      const service = createService();
      mockGet
        .mockResolvedValueOnce(healthPayload(200))
        .mockResolvedValueOnce({
          data: {
            query: '세입자 보호',
            k: 15,
            model: 'nlpai-lab/KURE-v1',
            results: chunkWindow([
              [101, 13],
              [102, 2],
            ]),
          },
        })
        .mockRejectedValueOnce(rejection);

      const result = await service.searchSemantic('세입자 보호', 5);

      expect(result.mode).toBe('semantic');
      expect(result.fallbackReason).toBeNull();
      expect(result.results.map((hit) => hit.noticeNum)).toEqual([101, 102]);
      expect(requestedChunkK()).toEqual([15, 30]);
      expect(mockSearchNotices).not.toHaveBeenCalled();
    },
  );

  it('falls back to keyword search when a first-window request fails with a non-axios error', async () => {
    const service = createService();
    mockGet.mockRejectedValue(new Error('socket hang up'));
    mockSearchNotices.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 5,
      totalPages: 1,
      keyword: '질의',
      source: 'archive',
    });

    const result = await service.searchSemantic('질의', 5);

    expect(result.mode).toBe('keyword_fallback');
    expect(result.fallbackReason).toContain('키워드 검색');
    // No sidecar response ever arrived -> no index time to report.
    expect(result.lastUpdateAt).toBeNull();
    expect(searchCalls()).toHaveLength(1);
    expect(mockSearchNotices).toHaveBeenCalledTimes(1);
  });

  it('returns an empty semantic answer when nothing qualifies', async () => {
    const service = createService();
    mockGet.mockResolvedValue({
      data: {
        query: '질의',
        k: 15,
        model: 'nlpai-lab/KURE-v1',
        lastUpdateAt: STAMP,
        results: [],
        weakResults: [],
      },
    });

    const result = await service.searchSemantic('질의', 5);

    // The sidecar already dropped unrelated hits, so an empty response is
    // the engine's verdict — the API reports "none" instead of quietly
    // substituting keyword hits for a query with no relevant match.
    expect(result.mode).toBe('semantic');
    expect(result.fallbackReason).toBeNull();
    expect(result.results).toEqual([]);
    expect(result.weakResults).toEqual([]);
    // The sidecar DID answer, so its index time still rides the response.
    expect(result.lastUpdateAt).toBe(STAMP);
    expect(searchCalls()).toHaveLength(1);
    expect(mockSearchNotices).not.toHaveBeenCalled();
  });

  it('falls back to keyword search when the sidecar reports 503 (model load failure)', async () => {
    const service = createService();
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 503 },
      message: 'Request failed with status code 503',
    });
    mockSearchNotices.mockResolvedValue({
      items: [
        {
          num: 7,
          subject: '키워드 결과',
          committee: '교육위원회',
        },
      ],
      total: 1,
      page: 1,
      limit: 5,
      totalPages: 1,
      keyword: '세입자 보호',
      source: 'archive',
    });

    const result = await service.searchSemantic('세입자 보호', 5);

    expect(result.mode).toBe('keyword_fallback');
    expect(result.fallbackReason).toContain('키워드 검색');
    expect(result.results).toEqual([
      {
        noticeNum: 7,
        subject: '키워드 결과',
        committee: '교육위원회',
        section: null,
        score: null,
        excerpt: null,
      },
    ]);
    expect(mockSearchNotices).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: '세입자 보호', page: 1, limit: 5 }),
    );
  });

  it('falls back to keyword search when the sidecar is unreachable', async () => {
    const service = createService();
    mockGet.mockRejectedValue({
      isAxiosError: true,
      code: 'ECONNREFUSED',
      message: 'connect ECONNREFUSED 127.0.0.1:8300',
    });
    mockSearchNotices.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 5,
      totalPages: 1,
      keyword: '세입자 보호',
      source: 'archive',
    });

    const result = await service.searchSemantic('세입자 보호', 5);

    expect(result.mode).toBe('keyword_fallback');
    expect(result.results).toEqual([]);
    expect(mockSearchNotices).toHaveBeenCalledTimes(1);
  });

  it('surfaces sidecar 4xx rejections as request errors without falling back', async () => {
    const service = createService();
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 422 },
      message: 'Request failed with status code 422',
    });

    await expect(service.searchSemantic('질의', 5)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mockSearchNotices).not.toHaveBeenCalled();
  });

  it('returns ServiceUnavailableException when the keyword fallback also fails', async () => {
    const service = createService();
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 503 },
      message: 'Request failed with status code 503',
    });
    mockSearchNotices.mockRejectedValue(new Error('crawler down'));

    await expect(
      service.searchSemantic('세입자 보호', 5),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('skips the sidecar entirely when semantic search is disabled', async () => {
    const service = createService(false);
    mockSearchNotices.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 5,
      totalPages: 1,
      keyword: '세입자 보호',
      source: 'archive',
    });

    const result = await service.searchSemantic('세입자 보호', 5);

    expect(mockGet).not.toHaveBeenCalled();
    expect(result.mode).toBe('keyword_fallback');
    expect(result.fallbackReason).toContain('비활성화');
  });

  it('returns the engine health fields the sidecar /health reports', async () => {
    const service = createService();
    mockGet.mockResolvedValue({
      data: {
        status: 'ready',
        model: 'nlpai-lab/KURE-v1',
        indexedChunks: 93031,
        lastUpdateAt: STAMP,
        lastUpdateResult: 'unchanged',
        lastUpdateTriggeredAt: TRIGGERED_AT,
        updating: false,
        generation: 2,
      },
    });

    const health = await service.getEngineHealth();

    expect(mockGet).toHaveBeenCalledWith('/health');
    // The readiness status and the three status-block fields cross the API
    // boundary; everything else the sidecar reports stays internal.
    expect(health).toEqual({
      status: 'ready',
      indexedChunks: 93031,
      lastUpdateAt: STAMP,
      lastUpdateTriggeredAt: TRIGGERED_AT,
    });
  });

  it('surfaces an unreachable sidecar as ServiceUnavailableException', async () => {
    const service = createService();
    mockGet.mockRejectedValue({
      isAxiosError: true,
      code: 'ECONNREFUSED',
      message: 'connect ECONNREFUSED 127.0.0.1:8300',
    });

    await expect(service.getEngineHealth()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(mockSearchNotices).not.toHaveBeenCalled();
  });

  it('reports engine status as unavailable when semantic search is disabled', async () => {
    const service = createService(false);

    await expect(service.getEngineHealth()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(mockGet).not.toHaveBeenCalled();
  });

  describe('lexical-evidence gate', () => {
    const gatedChunk = (
      noticeNum: number,
      text: string,
      lexicalEvidence: boolean,
    ) => ({
      ...sidecarChunk(noticeNum, text),
      lexicalEvidence,
    });

    const gateWindow = () => ({
      data: {
        query: '오늘 점심 메뉴',
        k: 15,
        model: 'nlpai-lab/KURE-v1',
        lastUpdateAt: STAMP,
        results: [
          gatedChunk(101, '증거 있는 청크', true),
          gatedChunk(102, '증거 없는 청크', false),
        ],
        weakResults: [gatedChunk(103, '약한 증거 없는 청크', false)],
      },
    });

    it('leaves responses untouched when the gate is off', async () => {
      const service = createService(true, 60_000, 'off');
      mockGet.mockResolvedValue(gateWindow());

      const result = await service.searchSemantic('오늘 점심 메뉴', 5);

      expect(result.results.map((hit) => hit.noticeNum)).toEqual([101, 102]);
      expect(result.weakResults.map((hit) => hit.noticeNum)).toEqual([103]);
    });

    it('serves full results but logs in shadow mode', async () => {
      const service = createService(true, 60_000, 'shadow');
      mockGet.mockResolvedValue(gateWindow());

      const result = await service.searchSemantic('오늘 점심 메뉴', 5);

      expect(result.mode).toBe('semantic');
      expect(result.results.map((hit) => hit.noticeNum)).toEqual([101, 102]);
      expect(result.weakResults.map((hit) => hit.noticeNum)).toEqual([103]);
    });

    it('drops hits without evidence in enforce mode', async () => {
      const service = createService(true, 60_000, 'enforce');
      mockGet.mockResolvedValue(gateWindow());

      const result = await service.searchSemantic('오늘 점심 메뉴', 5);

      expect(result.mode).toBe('semantic');
      expect(result.fallbackReason).toBeNull();
      expect(result.results.map((hit) => hit.noticeNum)).toEqual([101]);
      expect(result.weakResults).toEqual([]);
      expect(mockSearchNotices).not.toHaveBeenCalled();
    });

    it('answers explicit empty results without keyword fallback in enforce mode', async () => {
      const service = createService(true, 60_000, 'enforce');
      mockGet.mockResolvedValue({
        data: {
          query: '오늘 점심 메뉴',
          k: 15,
          model: 'nlpai-lab/KURE-v1',
          lastUpdateAt: STAMP,
          results: [gatedChunk(102, '증거 없는 청크', false)],
          weakResults: [gatedChunk(103, '약한 증거 없는 청크', false)],
        },
      });

      const result = await service.searchSemantic('오늘 점심 메뉴', 5);

      expect(result.mode).toBe('semantic');
      expect(result.fallbackReason).toBeNull();
      expect(result.results).toEqual([]);
      expect(result.weakResults).toEqual([]);
      expect(mockSearchNotices).not.toHaveBeenCalled();
    });

    it('keeps a notice when any of its chunks carries evidence', async () => {
      const service = createService(true, 60_000, 'enforce');
      mockGet.mockResolvedValue({
        data: {
          query: '질의',
          k: 15,
          model: 'nlpai-lab/KURE-v1',
          lastUpdateAt: STAMP,
          results: [
            gatedChunk(101, '증거 없는 대표 청크', false),
            gatedChunk(101, '증거 있는 두 번째 청크', true),
          ],
          weakResults: [],
        },
      });

      const result = await service.searchSemantic('질의', 5);

      // The best chunk still decides the content; evidence is OR over all.
      expect(result.results.map((hit) => hit.noticeNum)).toEqual([101]);
      expect(result.results[0].excerpt).toBe('증거 없는 대표 청크');
    });

    it('bypasses the gate on high-confidence dense matches', async () => {
      const service = createService(true, 60_000, 'enforce');
      mockGet.mockResolvedValue({
        data: {
          query: '공장에서 일하다 다쳤는데',
          k: 15,
          model: 'nlpai-lab/KURE-v1',
          lastUpdateAt: STAMP,
          // Top hit scores above the 0.6 bypass bar with no surface
          // evidence: a colloquial paraphrase the gate must not empty.
          results: [
            { ...gatedChunk(101, '증거 없는 고득점 청크', false), score: 0.62 },
            gatedChunk(102, '증거 있는 청크', true),
          ],
          weakResults: [],
        },
      });

      const result = await service.searchSemantic(
        '공장에서 일하다 다쳤는데',
        5,
      );

      expect(result.results.map((hit) => hit.noticeNum)).toEqual([101, 102]);
    });

    it('treats chunks from an older sidecar as evidence present', async () => {
      const service = createService(true, 60_000, 'enforce');
      mockGet.mockResolvedValue({
        data: {
          query: '세입자 보호',
          k: 15,
          model: 'nlpai-lab/KURE-v1',
          lastUpdateAt: STAMP,
          results: [sidecarChunk(101, '플래그 없는 청크')],
          weakResults: [],
        },
      });

      const result = await service.searchSemantic('세입자 보호', 5);

      expect(result.results.map((hit) => hit.noticeNum)).toEqual([101]);
    });
  });

  describe('rerank-cutoff leg', () => {
    const scoredChunk = (
      noticeNum: number,
      text: string,
      lexicalEvidence: boolean,
      rerankScore?: number | null,
    ) => ({
      ...sidecarChunk(noticeNum, text),
      lexicalEvidence,
      ...(rerankScore === undefined ? {} : { rerankScore }),
    });

    it('keeps high-rerank hits without lexical evidence in enforce mode', async () => {
      // The `예보법 개정` class: alias-expanded query, zero shared tokens,
      // rerank confident — the paraphrase class the lexical gate alone
      // would empty.
      const service = createService(true, 60_000, 'enforce', 0.6, -1);
      mockGet.mockResolvedValue({
        data: {
          query: '예보법 개정',
          k: 15,
          model: 'nlpai-lab/KURE-v1',
          lastUpdateAt: STAMP,
          results: [scoredChunk(101, '예금자보호법 청크', false, 3.33)],
          weakResults: [],
        },
      });

      const result = await service.searchSemantic('예보법 개정', 5);

      expect(result.results.map((hit) => hit.noticeNum)).toEqual([101]);
    });

    it('drops evidence-backed hits with a rejecting rerank in enforce mode', async () => {
      // The `오늘 점심 메뉴` class: generic tokens fake lexical evidence
      // while the reranker rejects the window outright.
      const service = createService(true, 60_000, 'enforce', 0.6, -1);
      mockGet.mockResolvedValue({
        data: {
          query: '오늘 점심 메뉴',
          k: 15,
          model: 'nlpai-lab/KURE-v1',
          lastUpdateAt: STAMP,
          results: [scoredChunk(101, '추천 청크', true, -4.02)],
          weakResults: [scoredChunk(102, '메뉴 청크', true, -5.53)],
        },
      });

      const result = await service.searchSemantic('오늘 점심 메뉴', 5);

      expect(result.mode).toBe('semantic');
      expect(result.results).toEqual([]);
      expect(result.weakResults).toEqual([]);
    });

    it('keeps bypassed evidence under a rejecting rerank', async () => {
      const service = createService(true, 60_000, 'enforce', 0.6, -1);
      mockGet.mockResolvedValue({
        data: {
          query: '고득점 질의',
          k: 15,
          model: 'nlpai-lab/KURE-v1',
          lastUpdateAt: STAMP,
          results: [
            { ...scoredChunk(101, '고득점 증거 청크', true, -2.5), score: 0.7 },
          ],
          weakResults: [],
        },
      });

      const result = await service.searchSemantic('고득점 질의', 5);

      expect(result.results.map((hit) => hit.noticeNum)).toEqual([101]);
    });

    it('falls back to the lexical rule for unscored chunks', async () => {
      const service = createService(true, 60_000, 'enforce', 0.6, -1);
      mockGet.mockResolvedValue({
        data: {
          query: '질의',
          k: 15,
          model: 'nlpai-lab/KURE-v1',
          lastUpdateAt: STAMP,
          results: [
            scoredChunk(101, '증거 있는 미채점 청크', true),
            scoredChunk(102, '증거 없는 미채점 청크', false),
          ],
          weakResults: [],
        },
      });

      const result = await service.searchSemantic('질의', 5);

      expect(result.results.map((hit) => hit.noticeNum)).toEqual([101]);
    });

    it('ignores rerank scores entirely when no cutoff is configured', async () => {
      const service = createService(true, 60_000, 'enforce');
      mockGet.mockResolvedValue({
        data: {
          query: '오늘 점심 메뉴',
          k: 15,
          model: 'nlpai-lab/KURE-v1',
          lastUpdateAt: STAMP,
          results: [scoredChunk(101, '추천 청크', true, -4.02)],
          weakResults: [],
        },
      });

      const result = await service.searchSemantic('오늘 점심 메뉴', 5);

      // Null cutoff is today's behavior: evidence alone keeps the hit.
      expect(result.results.map((hit) => hit.noticeNum)).toEqual([101]);
    });
  });
});
