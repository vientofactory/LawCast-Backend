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
  SemanticSearchResponse,
  SemanticSidecarChunk,
  SemanticSidecarSearchResponse,
} from './semantic-search.types';

const FALLBACK_REASON_UNAVAILABLE =
  '의미 검색 엔진을 사용할 수 없어 키워드 검색 결과를 반환합니다.';
const FALLBACK_REASON_DISABLED =
  '의미 검색 기능이 비활성화되어 있어 키워드 검색 결과를 반환합니다.';

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
   * Semantic search with graceful degradation: any sidecar outage (model
   * still loading, model load failure, network error, 5xx) falls back to the
   * existing keyword search. Only client-contract violations (4xx) are
   * surfaced as request errors.
   */
  async searchSemantic(query: string, k: number) {
    if (!this.enabled) {
      return this.keywordFallback(query, k, FALLBACK_REASON_DISABLED);
    }
    try {
      const response = await this.http.get<SemanticSidecarSearchResponse>(
        '/search',
        { params: { query, k } },
      );
      return {
        query,
        mode: 'semantic',
        fallbackReason: null,
        results: this.toNoticeHits(response.data.results),
      } satisfies SemanticSearchResponse;
    } catch (error) {
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
