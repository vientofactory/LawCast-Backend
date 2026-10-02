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
  const mockGet =
    jest.fn<(url: string, config: unknown) => Promise<{ data: unknown }>>();
  const mockSearchNotices =
    jest.fn<(query: unknown) => Promise<Record<string, unknown>>>();
  const mockedAxios = axios as jest.Mocked<typeof axios>;

  const createService = (enabled = true): SemanticSearchService => {
    mockedAxios.create.mockReturnValue({ get: mockGet } as any);

    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'semanticSearch.enabled') return enabled;
        if (key === 'semanticSearch.apiUrl') return 'http://127.0.0.1:8300';
        if (key === 'semanticSearch.timeout') return 10000;
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

  const requestedChunkK = (): number[] =>
    mockGet.mock.calls.map(
      (call) => (call[1] as { params: { k: number } }).params.k,
    );

  const chunkWindow = (spec: Array<[number, number]>) =>
    spec.flatMap(([noticeNum, count]) =>
      Array.from({ length: count }, (_, i) =>
        sidecarChunk(noticeNum, `청크 ${noticeNum}-${i}`),
      ),
    );

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
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('widens the chunk window until k notice hits are filled', async () => {
    const service = createService();
    mockGet
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
    // A full-size window holding `notices` distinct notices: the first
    // notice carries the bulk of the chunks, the rest one each.
    const window = (size: number, notices: number) => ({
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
    mockGet
      .mockResolvedValueOnce(window(150, 40))
      .mockResolvedValueOnce(window(200, 80));

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
      .mockResolvedValueOnce(singleNoticeWindow(150))
      .mockResolvedValueOnce(singleNoticeWindow(200));

    const result = await service.searchSemantic('질의', 50);

    expect(result.results).toHaveLength(1);
    expect(requestedChunkK()).toEqual([150, 200]);
    expect(mockGet).toHaveBeenCalledTimes(2);
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
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockSearchNotices).toHaveBeenCalledTimes(1);
  });

  it('falls back to keyword search when no semantic hit is collected', async () => {
    const service = createService();
    mockGet.mockResolvedValue({
      data: {
        query: '질의',
        k: 15,
        model: 'nlpai-lab/KURE-v1',
        lastUpdateAt: STAMP,
        results: [],
      },
    });
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

    // The keyword fallback is reserved for zero semantic evidence; an empty
    // window means the corpus is exhausted (no widening is attempted).
    expect(result.mode).toBe('keyword_fallback');
    expect(result.fallbackReason).toContain('의미 검색 결과가 없어');
    // The sidecar DID answer, so its index time still rides the response.
    expect(result.lastUpdateAt).toBe(STAMP);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockSearchNotices).toHaveBeenCalledTimes(1);
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
});
