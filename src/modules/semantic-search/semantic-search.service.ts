import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { NoticeSearchService } from '../crawling/notice-search.service';
import { LoggerUtils } from '../../utils/logger.utils';
import {
  CHUNK_FETCH_GROWTH,
  CHUNK_FETCH_INITIAL_FACTOR,
  SIDE_CAR_MAX_CHUNK_K,
} from './semantic-search.constants';
import {
  SemanticSearchResponse,
  SemanticSidecarChunk,
  SemanticSidecarSearchResponse,
} from './semantic-search.types';

const FALLBACK_REASON_UNAVAILABLE =
  '의미 검색 엔진을 사용할 수 없어 키워드 검색 결과를 반환합니다.';
const FALLBACK_REASON_DISABLED =
  '의미 검색 기능이 비활성화되어 있어 키워드 검색 결과를 반환합니다.';
const FALLBACK_REASON_NO_HITS =
  '의미 검색 결과가 없어 키워드 검색 결과를 반환합니다.';

@Injectable()
export class SemanticSearchService {
  private readonly logger = LoggerUtils.getContextLogger(
    SemanticSearchService.name,
  );
  private readonly http: AxiosInstance;
  private readonly enabled: boolean;

  constructor(
    configService: ConfigService,
    private readonly noticeSearchService: NoticeSearchService,
  ) {
    this.enabled = configService.get<boolean>('semanticSearch.enabled') ?? true;
    this.http = axios.create({
      baseURL: configService.get<string>('semanticSearch.apiUrl'),
      timeout: configService.get<number>('semanticSearch.timeout') ?? 10000,
    });
  }

  /**
   * Semantic search with graceful degradation. The failure policy is
   * per-phase so collected evidence is never discarded:
   * - first chunk-window failure (model loading/failed, network error, 5xx)
   *   degrades to the existing keyword search; client-contract violations
   *   (4xx) are surfaced as request errors;
   * - a failed widening request keeps the chunks already collected and
   *   returns partial semantic results (count < k is allowed) — the keyword
   *   fallback returns nothing for paraphrase queries, so partial semantic
   *   hits are strictly better;
   * - keyword fallback is used only when the first window failed or no
   *   semantic hit was collected at all.
   */
  async searchSemantic(query: string, k: number) {
    if (!this.enabled) {
      return this.keywordFallback(query, k, FALLBACK_REASON_DISABLED);
    }
    let collected: SemanticSidecarChunk[];
    try {
      collected = await this.collectChunks(query, k);
    } catch (error) {
      return this.handleFirstWindowFailure(error, query, k);
    }
    const hits = this.toNoticeHits(collected);
    if (hits.length === 0) {
      return this.keywordFallback(query, k, FALLBACK_REASON_NO_HITS);
    }
    return {
      query,
      mode: 'semantic',
      fallbackReason: null,
      results: hits.slice(0, k),
    } satisfies SemanticSearchResponse;
  }

  /**
   * First-window failure: no semantic evidence was collected. 4xx is a
   * client-contract violation (surfaced, never masked by a fallback); any
   * other failure degrades to keyword search.
   */
  private handleFirstWindowFailure(
    error: unknown,
    query: string,
    k: number,
  ): Promise<SemanticSearchResponse> {
    if (axios.isAxiosError(error)) {
      const status: number | undefined = error.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(
          `semantic sidecar rejected the request (status ${status}): ${error.message}`,
        );
        throw new BadRequestException(
          '의미 검색 요청이 거부되었습니다. 요청 형식을 확인해 주세요.',
        );
      }
      this.logger.warn(
        `semantic sidecar unavailable (${status ?? this.describeError(error)}); ` +
          'falling back to keyword search',
      );
    } else {
      this.logger.warn(
        `semantic search failed (${this.describeError(error)}); falling back to keyword search`,
      );
    }
    return this.keywordFallback(query, k, FALLBACK_REASON_UNAVAILABLE);
  }

  /**
   * Degraded path served by the existing keyword search (read-only reuse of
   * NoticeSearchService; its own behavior is unchanged).
   */
  private async keywordFallback(
    query: string,
    k: number,
    fallbackReason: string,
  ): Promise<SemanticSearchResponse> {
    try {
      const result = await this.noticeSearchService.searchNotices({
        keyword: query,
        page: 1,
        limit: k,
        includeDone: true,
        fullText: false,
      });
      return {
        query,
        mode: 'keyword_fallback',
        fallbackReason,
        results: result.items.map((item) => ({
          noticeNum: item.num,
          subject: item.subject,
          committee: item.committee,
          section: null,
          score: null,
          excerpt: null,
        })),
      };
    } catch (error) {
      this.logger.error(
        `keyword fallback failed for semantic search: ${this.describeError(error)}`,
      );
      throw new ServiceUnavailableException(
        '검색 서비스를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.',
      );
    }
  }

  /**
   * Collect chunk windows until they cover k distinct notices.
   *
   * `k` is a result count, not a cap: the sidecar ranks chunks, so one
   * top-chunkK fetch can collapse to fewer than k distinct notices. Fetch an
   * oversized chunk window first and widen it (growth up to the sidecar cap)
   * while dedup leaves the result short. Widening stops as soon as the
   * sidecar runs out of chunks (it returned fewer than requested), so a
   * small corpus costs exactly one request.
   *
   * Failure policy: only a failed FIRST window propagates (the caller turns
   * it into a fallback or a request error). A failed widening request keeps
   * the chunks collected so far — partial results beat discarding them.
   */
  private async collectChunks(
    query: string,
    k: number,
  ): Promise<SemanticSidecarChunk[]> {
    const collected: SemanticSidecarChunk[] = [];
    let chunkK = Math.min(k * CHUNK_FETCH_INITIAL_FACTOR, SIDE_CAR_MAX_CHUNK_K);
    for (;;) {
      let window: SemanticSidecarChunk[];
      try {
        window = await this.fetchChunks(query, chunkK);
      } catch (error) {
        if (collected.length === 0) {
          throw error;
        }
        this.logger.warn(
          `semantic sidecar chunk widening failed (${this.describeError(error)}); ` +
            `returning partial results from ${collected.length} collected chunks`,
        );
        return collected;
      }
      collected.push(...window);
      const hits = this.toNoticeHits(collected);
      const corpusExhausted = window.length < chunkK;
      if (
        hits.length >= k ||
        corpusExhausted ||
        chunkK >= SIDE_CAR_MAX_CHUNK_K
      ) {
        return collected;
      }
      chunkK = Math.min(chunkK * CHUNK_FETCH_GROWTH, SIDE_CAR_MAX_CHUNK_K);
    }
  }

  private async fetchChunks(
    query: string,
    chunkK: number,
  ): Promise<SemanticSidecarChunk[]> {
    const response = await this.http.get<SemanticSidecarSearchResponse>(
      '/search',
      { params: { query, k: chunkK } },
    );
    return response.data.results;
  }

  /**
   * Collapse chunk-level hits to notice-level results (best chunk per
   * notice), matching how retrieval quality is measured (notice-level rank).
   */
  private toNoticeHits(chunks: SemanticSidecarChunk[]) {
    const seen = new Set<number>();
    const hits: SemanticSearchResponse['results'] = [];
    for (const chunk of chunks) {
      if (seen.has(chunk.noticeNum)) {
        continue;
      }
      seen.add(chunk.noticeNum);
      hits.push({
        noticeNum: chunk.noticeNum,
        subject: chunk.subject,
        committee: chunk.committee,
        section: chunk.section,
        score: chunk.score,
        excerpt: chunk.text,
      });
    }
    return hits;
  }

  private describeError(error: unknown): string {
    return error instanceof AxiosError
      ? (error.code ?? error.message)
      : String((error as Error)?.message ?? error);
  }
}
