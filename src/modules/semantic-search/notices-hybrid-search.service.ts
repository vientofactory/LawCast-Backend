import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONSTANTS } from '../../config/app.config';
import { type AISummaryStatus } from '../../types/cache.types';
import { LoggerUtils } from '../../utils/logger.utils';
import { AI_SUMMARY_STATUS } from '../crawling/utils/ai-summary-status.utils';
import { NoticesQueryService } from '../crawling/notices-query.service';
import { ChangeTrackingService } from '../change-tracking/change-tracking.service';
import {
  NoticeArchiveService,
  type ArchiveNoticeItem,
} from '../notice/notice-archive.service';
import { SemanticSearchService } from './semantic-search.service';
import {
  type SemanticSearchResponse,
  type SemanticSearchResultItem,
} from './semantic-search.types';

/** Search mode the board (`/notices`) asks for. */
export type BoardSearchMode = 'keyword' | 'semantic' | 'auto';

const FALLBACK_REASON_ERROR =
  '의미 검색 중 문제가 발생하여 키워드 검색 결과를 반환합니다.';

/** Relevance metadata attached to a hydrated semantic board item. */
export interface BoardRelevance {
  score: number | null;
  section: string | null;
  excerpt: string | null;
  /** True only for items surfaced from the engine's weak tier. */
  weak: boolean;
}

export interface BoardNoticeItem {
  num: number;
  subject: string;
  proposerCategory: string;
  committee: string;
  link: string;
  contentId: string | null;
  isDone: boolean;
  aiSummary: string | null;
  aiSummaryStatus: AISummaryStatus;
  attachments: { pdfFile: string; hwpFile: string };
  lifecycleStatus: ArchiveNoticeItem['lifecycleStatus'];
  sourceDeletedAt: Date | null;
  archiveStartedAt: Date | null;
  changeEventCount?: number;
  relevance?: BoardRelevance;
}

export interface BoardSearchSemanticMeta {
  mode: 'semantic' | 'keyword_fallback';
  fallbackReason: string | null;
  lastUpdateAt: string | null;
  /** Engine-ranked notice count before archive filters were applied. */
  candidateTotal: number;
  weakResults: SemanticSearchResultItem[];
}

export interface BoardSearchResult {
  items: BoardNoticeItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  search: string;
  proposer: string;
  startDate: string;
  endDate: string;
  sortOrder: 'asc' | 'desc';
  /** Mode the caller asked for. */
  searchMode: BoardSearchMode;
  /** Mode that actually served the response. */
  appliedMode: 'keyword' | 'semantic';
  semantic: BoardSearchSemanticMeta | null;
  stats: {
    cacheCount: number;
    matchedCacheCount: number;
    archiveCount: number;
    totalArchiveCount: number;
    mergedCount: number;
  };
}

export interface BoardSearchParams {
  searchMode: BoardSearchMode;
  search: string;
  proposer?: string;
  startDate?: string;
  endDate?: string;
  sortOrder?: 'asc' | 'desc';
  isDone?: boolean;
  page: number;
  limit: number;
}

/** Loose shape accepted from both the archive and the cache mapping. */
interface RawBoardItem {
  num: number;
  subject: string;
  proposerCategory: string;
  committee: string;
  link: string;
  contentId?: string | null;
  isDone?: boolean;
  aiSummary?: string | null;
  aiSummaryStatus?: AISummaryStatus;
  attachments?: { pdfFile?: string; hwpFile?: string };
  lifecycleStatus?: ArchiveNoticeItem['lifecycleStatus'];
  sourceDeletedAt?: Date | null;
  archiveStartedAt?: Date | null;
  changeEventCount?: number;
  relevance?: BoardRelevance;
}

function toBoardItem(item: RawBoardItem): BoardNoticeItem {
  return {
    num: item.num,
    subject: item.subject,
    proposerCategory: item.proposerCategory,
    committee: item.committee,
    link: item.link,
    contentId: item.contentId ?? null,
    isDone: item.isDone ?? false,
    aiSummary: item.aiSummary ?? null,
    aiSummaryStatus:
      item.aiSummaryStatus ??
      (AI_SUMMARY_STATUS.NOT_REQUESTED as AISummaryStatus),
    attachments: {
      pdfFile: item.attachments?.pdfFile ?? '',
      hwpFile: item.attachments?.hwpFile ?? '',
    },
    lifecycleStatus: item.lifecycleStatus ?? 'active',
    sourceDeletedAt: item.sourceDeletedAt ?? null,
    archiveStartedAt: item.archiveStartedAt ?? null,
    ...(item.changeEventCount === undefined
      ? {}
      : { changeEventCount: item.changeEventCount }),
    ...(item.relevance ? { relevance: item.relevance } : {}),
  };
}

/**
 * Board-level search orchestration for `/api/notices/archive`'s `searchMode`.
 *
 * `keyword` (and any request without a query, or with scoped `noticeNums`)
 * keeps the existing keyword path untouched. `semantic`/`auto` resolve the
 * engine's relevance-ranked notice numbers and hydrate them into the same card
 * rows, applying the archive filters as a post-filter and preserving relevance
 * order. The engine being unavailable degrades to the keyword path with a
 * `keyword_fallback` marker rather than blanking the board — a search page must
 * never 500 because the sidecar is down (see SemanticSearchService).
 */
@Injectable()
export class NoticesHybridSearchService {
  private readonly logger = LoggerUtils.getContextLogger(
    NoticesHybridSearchService.name,
  );
  private readonly maxNotices: number;

  constructor(
    configService: ConfigService,
    private readonly semanticSearchService: SemanticSearchService,
    private readonly noticesQueryService: NoticesQueryService,
    private readonly noticeArchiveService: NoticeArchiveService,
    private readonly changeTrackingService: ChangeTrackingService,
  ) {
    this.maxNotices =
      configService.get<number>('semanticSearch.hybridMaxNotices') ?? 100;
  }

  async search(params: BoardSearchParams): Promise<BoardSearchResult> {
    const search = (params.search || '').trim();

    // No query = nothing to rank; keyword mode is the existing path.
    if (params.searchMode === 'keyword' || !search) {
      return this.keywordResult(params, null);
    }

    let semantic: SemanticSearchResponse;
    try {
      semantic = await this.semanticSearchService.searchSemantic(
        search,
        this.maxNotices,
      );
    } catch (error) {
      // A rejected request (over-long query etc.) is a client error and must
      // surface; anything else degrades to keyword rather than failing the page.
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.warn(
        `semantic board search failed: ${(error as Error)?.message ?? error}`,
      );
      return this.keywordResult(params, {
        mode: 'keyword_fallback',
        fallbackReason: FALLBACK_REASON_ERROR,
        lastUpdateAt: null,
        candidateTotal: 0,
        weakResults: [],
      });
    }

    if (semantic.mode === 'keyword_fallback') {
      return this.keywordResult(params, {
        mode: 'keyword_fallback',
        fallbackReason: semantic.fallbackReason,
        lastUpdateAt: semantic.lastUpdateAt,
        candidateTotal: 0,
        weakResults: semantic.weakResults,
      });
    }

    return this.semanticResult(params, semantic);
  }

  /**
   * Keyword path (explicit keyword mode, no query, or a semantic fallback).
   * Reuses the tested NoticesQueryService path unchanged so filters, cache
   * merge and pagination behave exactly as before.
   */
  private async keywordResult(
    params: BoardSearchParams,
    semantic: BoardSearchSemanticMeta | null,
  ): Promise<BoardSearchResult> {
    const result = await this.noticesQueryService.getArchivedNotices({
      page: params.page,
      limit: params.limit,
      search: params.search,
      proposer: params.proposer,
      startDate: params.startDate,
      endDate: params.endDate,
      sortOrder: params.sortOrder,
      isDone: params.isDone,
    });

    return {
      items: result.items.map((item) => toBoardItem(item)),
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
      search: result.search,
      proposer: result.proposer ?? '',
      startDate: result.startDate ?? '',
      endDate: result.endDate ?? '',
      sortOrder: result.sortOrder ?? 'desc',
      searchMode: params.searchMode,
      appliedMode: 'keyword',
      semantic,
      stats: result.stats,
    };
  }

  /**
   * Semantic path: hydrate the engine's ranked notice numbers, apply archive
   * filters, append cache-only keyword matches, then paginate the combined
   * relevance-ordered list.
   */
  private async semanticResult(
    params: BoardSearchParams,
    semantic: SemanticSearchResponse,
  ): Promise<BoardSearchResult> {
    const search = params.search.trim();
    const proposer = (params.proposer || '').trim();
    const range = this.noticesQueryService.parseDateRange(
      params.startDate,
      params.endDate,
    );
    const safePage = Math.max(
      APP_CONSTANTS.API.PAGINATION.MIN_PAGE,
      params.page,
    );
    const safeLimit = Math.min(
      APP_CONSTANTS.API.PAGINATION.MAX_LIMIT,
      Math.max(APP_CONSTANTS.API.PAGINATION.MIN_LIMIT, params.limit),
    );

    const rankedNums = semantic.results.map((hit) => hit.noticeNum);
    const relevanceByNum = new Map(
      semantic.results.map((hit) => [hit.noticeNum, hit] as const),
    );

    const { items: archiveItems } =
      await this.noticeArchiveService.getArchiveNoticesByRankedNums({
        noticeNums: rankedNums,
        proposer: proposer || undefined,
        startDate: range.startDate,
        endDate: range.endDate,
        isDone: params.isDone,
      });

    const changeCounts =
      await this.changeTrackingService.getChangeEventCountsByNoticeNums(
        archiveItems.map((item) => item.num),
      );

    const rankedItems: BoardNoticeItem[] = archiveItems.map((item) => {
      const hit = relevanceByNum.get(item.num);
      return toBoardItem({
        ...item,
        changeEventCount: changeCounts.get(item.num),
        relevance: {
          score: hit?.score ?? null,
          section: hit?.section ?? null,
          excerpt: hit?.excerpt ?? null,
          weak: false,
        },
      });
    });

    // Cache-only (active, not-yet-archived) notices are invisible to the index;
    // append keyword matches so freshly crawled bills are not lost. Mirrors the
    // keyword path's rule: skip when a date filter applies (cache items carry no
    // archive_started_at) or the request is scoped to ended notices.
    const hasDateFilter = Boolean(range.startDate || range.endDate);
    const cacheOnlyItems =
      hasDateFilter || params.isDone === true
        ? []
        : await this.noticesQueryService.getCacheOnlySearchMatches({
            search,
            proposer,
          });

    const present = new Set(rankedItems.map((item) => item.num));
    const appendedCacheItems: BoardNoticeItem[] = cacheOnlyItems
      .filter((item) => !present.has(item.num))
      .map((item) => toBoardItem(item));

    const combined = [...rankedItems, ...appendedCacheItems];
    const total = combined.length;
    const start = (safePage - 1) * safeLimit;
    const items = combined.slice(start, start + safeLimit);
    const totalArchiveCount = await this.noticeArchiveService.getArchiveCount();

    return {
      items,
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
      search,
      proposer,
      startDate: range.startDateRaw,
      endDate: range.endDateRaw,
      sortOrder: params.sortOrder === 'asc' ? 'asc' : 'desc',
      searchMode: params.searchMode,
      appliedMode: 'semantic',
      semantic: {
        mode: 'semantic',
        fallbackReason: null,
        lastUpdateAt: semantic.lastUpdateAt,
        candidateTotal: rankedNums.length,
        weakResults: semantic.weakResults,
      },
      stats: {
        cacheCount: cacheOnlyItems.length,
        matchedCacheCount: appendedCacheItems.length,
        archiveCount: rankedItems.length,
        totalArchiveCount,
        mergedCount: total,
      },
    };
  }
}
