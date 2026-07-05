import type { ITableData } from 'pal-crawl';

export interface CacheInfo {
  size: number;
  lastUpdated: Date | null;
  maxSize: number;
  isInitialized: boolean;
}

export type AISummaryStatus =
  | 'ready'
  | 'unavailable'
  | 'not_supported'
  | 'not_requested';

type CachedBaseNotice = Omit<ITableData, 'numComments'>;

export interface CachedNotice extends CachedBaseNotice {
  aiSummary?: string | null;
  aiSummaryStatus?: AISummaryStatus;
  /**
   * Stored proposal reason for NsmLmSts bills (contentId=null).
   * Populated by archive service and used by AI summary backfill.
   */
  proposalReason?: string | null;
}

export interface QuickKeywordSuggestion {
  keyword: string;
  score: number;
  matchCount: number;
}

export interface QuickKeywordSuggestionsCache {
  items: QuickKeywordSuggestion[];
  updatedAt: string;
  sourceNoticeCount: number;
}

export interface QuickKeywordSuggestionsResult {
  items: QuickKeywordSuggestion[];
  updatedAt: string | null;
  sourceNoticeCount: number;
  refreshIntervalMs: number;
}
