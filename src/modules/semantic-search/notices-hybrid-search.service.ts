import { MAX_K } from './semantic-search.constants';
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
import {
  legalLookupPrefix,
  parseNoticeNumber,
} from '../notice/utils/legal-search-identity.util';
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
  /** Bounded ranked candidate count before hydration. */
  candidateTotal: number;
  weakResults: SemanticSearchResultItem[];
  suggestedQuery?: string;
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

interface LegalCandidates {
  noticeNums: number[];
  suggestedQuery?: string;
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
  private readonly autoExact: boolean;

  constructor(
    configService: ConfigService,
    private readonly semanticSearchService: SemanticSearchService,
    private readonly noticesQueryService: NoticesQueryService,
    private readonly noticeArchiveService: NoticeArchiveService,
    private readonly changeTrackingService: ChangeTrackingService,
  ) {
    this.autoExact =
      configService.get<boolean>('semanticSearch.autoExact') ?? true;
    this.maxNotices = Math.min(
      Math.max(
        1,
        configService.get<number>('semanticSearch.hybridMaxNotices') ?? MAX_K,
      ),
      MAX_K,
    );
  }

  async search(params: BoardSearchParams): Promise<BoardSearchResult> {
    const search = (params.search || '').trim();

    // No query = nothing to rank; keyword mode is the existing path.
    if (params.searchMode === 'keyword' || !search) {
      return this.keywordResult(params, null);
    }

    const noticeNumber =
      this.autoExact && params.searchMode === 'auto'
        ? parseNoticeNumber(search)
        : undefined;
    if (noticeNumber !== undefined) {
      // A bill identifier has no semantic expansion; hydrate the scoped row only.
      return this.semanticResult(
        params,
        {
          query: search,
          mode: 'semantic',
          fallbackReason: null,
          lastUpdateAt: null,
          results: [],
          weakResults: [],
        },
        noticeNumber,
      );
    }

    let semantic: SemanticSearchResponse;
    let exact: LegalCandidates;
    try {
      [semantic, exact] = await Promise.all([
        this.semanticSearchService.searchSemantic(search, this.maxNotices),
        this.legalCandidates(params, search),
      ]);
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

    return this.semanticResult(params, semantic, undefined, exact);
  }

  private async legalCandidates(
    params: BoardSearchParams,
    query: string,
  ): Promise<LegalCandidates> {
    if (
      !this.autoExact ||
      params.searchMode !== 'auto' ||
      !legalLookupPrefix(query)
    ) {
      return { noticeNums: [] };
    }
    try {
      const range = this.noticesQueryService.parseDateRange(
        params.startDate,
        params.endDate,
      );
      return await this.noticeArchiveService.findLegalIdentityCandidates({
        query,
        limit: this.maxNotices,
        proposer: params.proposer?.trim() || undefined,
        startDate: range.startDate,
        endDate: range.endDate,
        isDone: params.isDone,
      });
    } catch (error) {
      this.logger.warn(
        `legal identity lookup failed: ${(error as Error)?.message ?? error}`,
      );
      return { noticeNums: [] };
    }
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
   * Semantic path: filter ranked notices, then hydrate only the requested
   * page. Cache-only keyword matches follow the entire ranked archive set.
   */
  private async semanticResult(
    params: BoardSearchParams,
    semantic: SemanticSearchResponse,
    exactNumber?: number,
    exact: LegalCandidates = { noticeNums: [] },
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

    const preferred =
      exactNumber === undefined ? exact.noticeNums : [exactNumber];
    const rankedNums = [
      ...new Set([
        ...preferred,
        ...semantic.results.map((hit) => hit.noticeNum),
      ]),
    ].slice(0, this.maxNotices);
    const relevanceByNum = new Map(
      semantic.results.map((hit) => [hit.noticeNum, hit] as const),
    );

    const start = (safePage - 1) * safeLimit;
    const { items: archiveItems, matchingNoticeNums } =
      await this.noticeArchiveService.getArchiveNoticesByRankedNums({
        noticeNums: rankedNums,
        proposer: proposer || undefined,
        startDate: range.startDate,
        endDate: range.endDate,
        isDone: params.isDone,
        offset: start,
        limit: safeLimit,
      });

    const changeCounts = archiveItems.length
      ? await this.changeTrackingService.getChangeEventCountsByNoticeNums(
          archiveItems.map((item) => item.num),
        )
      : new Map<number, number>();

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
      hasDateFilter ||
      params.isDone === true ||
      (exactNumber !== undefined && matchingNoticeNums.length > 0)
        ? []
        : await this.noticesQueryService.getCacheOnlySearchMatches({
            ...(exactNumber === undefined
              ? { search }
              : { noticeNum: exactNumber }),
            proposer,
          });

    const present = new Set(matchingNoticeNums);
    const appendedCacheItems = cacheOnlyItems.filter(
      (item) =>
        !present.has(item.num) &&
        (exactNumber === undefined || item.num === exactNumber),
    );

    const archiveCount = matchingNoticeNums.length;
    const total = archiveCount + appendedCacheItems.length;
    const cacheStart = Math.max(0, start - archiveCount);
    const cacheEnd = Math.max(0, start + safeLimit - archiveCount);
    const items = [
      ...rankedItems,
      ...appendedCacheItems
        .slice(cacheStart, cacheEnd)
        .map((item) => toBoardItem(item)),
    ];
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
        weakResults: preferred.length
          ? semantic.weakResults.filter((hit) => !present.has(hit.noticeNum))
          : semantic.weakResults,
        ...(exact.suggestedQuery
          ? { suggestedQuery: exact.suggestedQuery }
          : {}),
      },
      stats: {
        cacheCount: cacheOnlyItems.length,
        matchedCacheCount: appendedCacheItems.length,
        archiveCount,
        totalArchiveCount,
        mergedCount: total,
      },
    };
  }
}
